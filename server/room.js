// Uma sala = uma partida. Roda a simulacao autoritativa em tick fixo e envia
// snapshots para os clientes conectados.

import { CFG, MODES, STATE } from "./shared/constants.js";
import { createWorld, step, serialize, getEnt, resetPositions } from "./shared/sim.js";
import { S2C, encode } from "./shared/protocol.js";

let nextRoomId = 1;

// Pedacos fixos do envelope do snapshot, montados uma vez so.
const SNAP_HEAD = `{"t":"${S2C.SNAPSHOT}","d":`;
const SNAP_ACK = `,"ack":`;

export class Room {
  constructor(mode, opts = {}) {
    this.id = nextRoomId++;
    this.mode = mode;                 // "1v1" | "2v2" | "3v3" | "4v4"
    this.teamSize = MODES[mode];
    this.private = !!opts.private;    // sala privada: exige codigo para entrar
    this.code = opts.code || "";      // codigo de 4-6 digitos (salas privadas)
    this.onEmpty = opts.onEmpty;
    this.world = createWorld(this.teamSize, { aiKeeper: true });
    this.clients = new Map();         // client.id -> client
    this.inputs = new Map();          // entId -> input
    this.timer = null;
    this.started = false;
    this.accum = 0;
    this.lastTime = 0;
    this.snapCounter = 0;
    this.snapPendente = false;
    this.capacity = this.teamSize * 2;
  }

  get playerCount() {
    return this.clients.size;
  }

  get isFull() {
    return this.clients.size >= this.capacity;
  }

  // Info publica exibida na lista de salas (nao expoe o codigo de privadas)
  publicInfo() {
    return {
      id: this.id,
      mode: this.mode,
      private: this.private,
      players: this.playerCount,
      capacity: this.capacity,
      started: this.started
    };
  }

  // Distribui o novo jogador no time com menos gente
  pickSlot(client) {
    // Se o jogador ja tinha um boneco (reconectou), devolve ele
    if (client.uid) {
      for (const e of this.world.ents) {
        if (e.uid === client.uid && e.isBot) return e;
      }
    }
    const count = [0, 0];
    for (const c of this.clients.values()) count[c.team]++;
    const team = count[0] <= count[1] ? 0 : 1;

    // Quem escolheu ser goleiro pega a meta do time, se ela ainda estiver livre.
    // Se ja tiver dono, cai para a linha em vez de recusar a entrada — ficar de
    // fora da partida seria pior do que jogar na linha.
    if (client.role === "keeper") {
      for (const e of this.world.ents) {
        if (e.team === team && e.role === "keeper" && e.isBot) return e;
      }
      for (const e of this.world.ents) {
        if (e.role === "keeper" && e.isBot) return e;
      }
    }

    // Encontra uma entidade de linha desse time que ainda esteja como bot (preferencialmente sem dono)
    for (const e of this.world.ents) {
      if (e.team === team && e.role === "field" && e.isBot && !e.uid) return e;
    }
    // Fallback 1: qualquer entidade de linha do time (mesmo que fosse de outro jogador que caiu)
    for (const e of this.world.ents) {
      if (e.team === team && e.role === "field" && e.isBot) return e;
    }
    // Fallback 2: qualquer entidade de linha livre
    for (const e of this.world.ents) {
      if (e.role === "field" && e.isBot) return e;
    }
    return null;
  }

  addClient(client) {
    // Evita o mesmo UID conectado duas vezes na mesma sala
    if (client.uid) {
      for (const existingClient of this.clients.values()) {
        if (existingClient.uid === client.uid && existingClient.id !== client.id) {
           this.removeClient(existingClient);
           try { existingClient.ws.close(); } catch(e){}
        }
      }
    }

    const ent = this.pickSlot(client);
    if (!ent) return false;
    ent.isBot = false;
    if (client.uid) ent.uid = client.uid;
    ent.name = client.name || "CRIA";
    ent.customConfig = client.customConfig || null;
    ent.mpGoals = client.mpGoals || 0;
    ent.cardTier = client.cardTier || "silver";
    client.entId = ent.id;
    client.team = ent.team;
    client.room = this;
    this.clients.set(client.id, client);

    this.broadcastMatchState();

    // Comeca assim que a sala enche; se nao encher em 12s, comeca com bots
    if (this.isFull) {
      this.start();
    } else if (!this.fillTimer && !this.started) {
      this.fillTimer = setTimeout(() => this.start(), 12000);
    }
    return true;
  }

  removeClient(client) {
    if (!this.clients.has(client.id)) return;
    this.clients.delete(client.id);
    this.inputs.delete(client.entId);
    const ent = getEnt(this.world, client.entId);
    if (ent) {
      // Vira bot para a partida continuar equilibrada
      ent.isBot = true;
      ent.name = "BOT";
    }
    client.room = null;
    client.entId = 0;

    this.broadcast(S2C.PLAYER_LEFT, { entId: ent ? ent.id : 0 });

    if (this.clients.size === 0) {
      this.stop();
      this.onEmpty?.(this);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.fillTimer) { clearTimeout(this.fillTimer); this.fillTimer = null; }
    this.world.running = true;
    this.world.timeLeft = CFG.MATCH;
    this.world.score = [0, 0];
    resetPositions(this.world, 1);

    this.broadcastMatchState(true);

    // Relogio com acumulador em vez de um passo por disparo do timer.
    //
    // setInterval NAO garante 33,3ms: sob carga (varias salas, GC, o plano free
    // do Render) ele dispara com 40, 50, as vezes 90ms. Rodando um passo fixo
    // por disparo, a partida simplesmente ANDAVA MAIS DEVAGAR do que o relogio
    // de parede — a bola ficava lenta, o cronometro atrasava e todo mundo
    // sentia "lag" sem perder um pacote sequer.
    //
    // Agora o passo continua fixo (a fisica precisa disso para ser
    // determinista), mas o numero de passos vem do tempo que passou de verdade.
    // O teto de 5 passos evita a espiral da morte: se o processo ficou parado
    // meio segundo, ele perde esse tempo em vez de tentar recuperar tudo de uma
    // vez e travar de novo.
    this.accum = 0;
    this.lastTime = Date.now();
    this.timer = setInterval(() => this.avancar(), 1000 / CFG.TICK_HZ);
  }

  avancar() {
    const dt = 1 / CFG.TICK_HZ;
    const agora = Date.now();
    let passado = (agora - this.lastTime) / 1000;
    this.lastTime = agora;
    if (!(passado > 0)) passado = dt;
    if (passado > 0.5) passado = 0.5;   // pausa longa: descarta em vez de acumular

    this.accum += passado;
    let passos = 0;
    while (this.accum >= dt && passos < 5) {
      this.accum -= dt;
      passos++;
      if (this.tick(dt) === false) return;   // partida acabou: para o relogio
    }
    // Fora do laco: no maximo um envio por disparo, ja com o estado final.
    this.enviarSnapshot();
    // Sobrou muito no acumulador depois do teto: o servidor nao esta dando
    // conta. Zerar mantem o jogo no presente (e melhor pular do que ficar
    // devendo tempo para sempre).
    if (this.accum > dt * 5) this.accum = 0;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.fillTimer) { clearTimeout(this.fillTimer); this.fillTimer = null; }
    this.started = false;
  }

  tick(dt) {
    const event = step(this.world, dt, this.inputs);

    // O tick leu os inputs: dali para frente um pacote novo pode sobrescrever
    // os botoes sem risco. Ver setInput().
    for (const i of this.inputs.values()) i.consumido = true;

    if (event?.type === "goal") {
      this.broadcast(S2C.GOAL, { team: event.team, score: this.world.score, scorerEntId: event.scorerEntId });
      // Comemoracao: time que marcou dança brevemente (até a bola voltar ao jogo)
      for (const e of this.world.ents) {
        if (e.role === "keeper" || e.team !== event.team) continue;
        if (e.act > 0) continue;
        e.state = STATE.DANCE;
        e.act = 0.9;
        e.cool = 1.0;
      }
    } else if (event?.type === "end") {
      this.broadcast(S2C.MATCH_END, { score: this.world.score });
      this.stop();
      // Reinicia depois de 8s para quem ficar na sala
      setTimeout(() => {
        if (this.clients.size > 0) {
          this.started = false;
          this.start();
        }
      }, 8000);
      return false;    // avisa o acumulador para nao dar mais passos neste ciclo
    }

    // Aqui o tick apenas MARCA que ha snapshot devido. Quem envia e avancar(),
    // uma vez so por disparo do timer — ver enviarSnapshot().
    this.snapCounter += CFG.SNAP_HZ;
    if (this.snapCounter >= CFG.TICK_HZ) {
      this.snapCounter -= CFG.TICK_HZ;
      this.snapPendente = true;
    }
  }

  // Envia UM snapshot com o estado mais recente.
  //
  // Antes isto vivia dentro do tick, ou seja, dentro do laco do acumulador.
  // Quando o timer atrasava (plano free do Render, GC, varias salas), o laco
  // dava 2 ou 3 passos de recuperacao de uma vez e disparava 2 ou 3 snapshots
  // NO MESMO MILISSEGUNDO, seguidos de um buraco do tamanho do atraso.
  //
  // Para o cliente isso e pior do que o atraso em si: ele dimensiona o buffer
  // de interpolacao pelo PIOR espacamento recente, entao uma rajada seguida de
  // um vao de 100ms fazia o buffer saltar de 75ms para ~220ms — e o adversario
  // aparecia travando e corrigindo. Os snapshots do meio da rajada nem serviam
  // para nada: estao todos a menos de um quadro de distancia um do outro.
  //
  // Enviando uma vez por disparo, o cliente recebe um fluxo honesto (um pacote,
  // sempre o estado mais fresco) e o pico de banda da recuperacao some junto.
  enviarSnapshot() {
    if (!this.snapPendente) return;
    this.snapPendente = false;
    if (this.clients.size === 0) return;
    // O estado e o mesmo para todo mundo; so o ack (ultimo input processado)
    // muda por cliente. Serializar uma vez e concatenar o ack evita repetir
    // o JSON.stringify do mundo inteiro por jogador — num 4v4 eram 8
    // serializacoes identicas a cada snapshot.
    const body = JSON.stringify(serialize(this.world));
    const head = SNAP_HEAD + body.slice(0, -1) + SNAP_ACK;
    for (const c of this.clients.values()) {
      c.sendRaw(head + (c.lastSeq || 0) + "}}");
    }
  }

  setInput(client, input) {
    if (!client.entId) return;
    // Ignora pacotes fora de ordem (chegaram atrasados)
    if (input.seq != null && client.lastSeq != null && input.seq <= client.lastSeq) return;
    client.lastSeq = input.seq ?? 0;

    // Sanitiza: o cliente so manda direcao e botoes; velocidade e do servidor
    const dl = Math.hypot(input.dx || 0, input.dz || 0) || 1;
    const safe = {
      consumido: false,
      dx: (input.dx || 0) / (dl > 1 ? dl : 1),
      dz: (input.dz || 0) / (dl > 1 ? dl : 1),
      sprint: !!input.sprint,
      shoot: !!input.shoot,
      pass: !!input.pass,
      tackle: !!input.tackle,
      steal: !!input.steal,
      dribble: !!input.dribble,
      jump: !!input.jump,
      callPass: !!input.callPass,
      aimx: clampNum(input.aimx, -60, 60),
      aimy: clampNum(input.aimy, 0, 12),
      aimz: clampNum(input.aimz, -60, 60)
    };

    // Botoes de toque unico (drible, carrinho, desarme, pulo) sao uma BORDA: a
    // simulacao so dispara a acao no tick em que o botao acabou de descer. Com
    // cliente e servidor a 30 Hz, dois pacotes chegando entre dois ticks eram
    // suficientes para o segundo apagar o toque do primeiro — e o drible
    // simplesmente nao saia, sem nada na tela explicando por que.
    //
    // Enquanto o tick nao le o pacote, o toque fica retido: nenhum clique se
    // perde por jitter de rede.
    const pendente = this.inputs.get(client.entId);
    if (pendente && !pendente.consumido) {
      safe.dribble  = safe.dribble  || pendente.dribble;
      safe.tackle   = safe.tackle   || pendente.tackle;
      safe.steal    = safe.steal    || pendente.steal;
      safe.jump     = safe.jump     || pendente.jump;
      safe.callPass = safe.callPass || pendente.callPass;
    }

    this.inputs.set(client.entId, safe);
  }

  matchStatePayload() {
    return {
      room: this.id,
      mode: this.mode,
      private: this.private,
      code: this.private ? this.code : undefined,
      teamSize: this.teamSize,
      started: this.started,
      capacity: this.capacity,
      players: this.playerCount,
      match: CFG.MATCH,
      roster: this.world.ents.map((e) => ({
        id: e.id, team: e.team, role: e.role, foot: e.foot,
        keeper: e.role === "keeper",
        bot: e.isBot, name: e.name || (e.isBot ? "BOT" : "CRIA"),
        customConfig: e.customConfig,
        mpGoals: e.mpGoals || 0,
        cardTier: e.cardTier || (e.isBot ? "silver" : "silver")
      }))
    };
  }

  broadcastMatchState(started = false) {
    for (const c of this.clients.values()) {
      c.send(S2C.MATCH_START, {
        ...this.matchStatePayload(),
        started: started || this.started,
        youEnt: c.entId,
        youTeam: c.team
      });
    }
  }

  broadcast(type, data) {
    for (const c of this.clients.values()) c.send(type, data);
  }
}

function clampNum(v, a, b) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < a ? a : n > b ? b : n;
}
