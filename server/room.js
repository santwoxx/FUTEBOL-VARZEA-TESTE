// Uma sala = uma partida. Roda a simulacao autoritativa em tick fixo e envia
// snapshots para os clientes conectados.

import { CFG, MODES, STATE } from "./shared/constants.js";
import { createWorld, step, serialize, getEnt, resetPositions } from "./shared/sim.js";
import { S2C, encode } from "./shared/protocol.js";

let nextRoomId = 1;

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
        if (e.uid === client.uid && e.role === "field" && e.isBot) return e;
      }
    }
    const count = [0, 0];
    for (const c of this.clients.values()) count[c.team]++;
    const team = count[0] <= count[1] ? 0 : 1;
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

    const dt = 1 / CFG.TICK_HZ;
    this.lastTime = Date.now();
    this.timer = setInterval(() => this.tick(dt), 1000 / CFG.TICK_HZ);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.fillTimer) { clearTimeout(this.fillTimer); this.fillTimer = null; }
    this.started = false;
  }

  tick(dt) {
    const event = step(this.world, dt, this.inputs);

    if (event?.type === "goal") {
      this.broadcast(S2C.GOAL, { team: event.team, score: this.world.score });
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
      return;
    }

    // Snapshots a SNAP_HZ (nao a cada tick, para economizar banda)
    this.snapCounter += CFG.SNAP_HZ;
    if (this.snapCounter >= CFG.TICK_HZ) {
      this.snapCounter -= CFG.TICK_HZ;
      const snap = serialize(this.world);
      for (const c of this.clients.values()) {
        // Cada cliente recebe o ultimo input processado dele, para reconciliacao
        snap.ack = c.lastSeq || 0;
        c.send(S2C.SNAPSHOT, snap);
      }
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
      dx: (input.dx || 0) / (dl > 1 ? dl : 1),
      dz: (input.dz || 0) / (dl > 1 ? dl : 1),
      sprint: !!input.sprint,
      shoot: !!input.shoot,
      pass: !!input.pass,
      tackle: !!input.tackle,
      steal: !!input.steal,
      dribble: !!input.dribble,
      jump: !!input.jump,
      aimx: clampNum(input.aimx, -60, 60),
      aimy: clampNum(input.aimy, 0, 12),
      aimz: clampNum(input.aimz, -60, 60)
    };
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
        bot: e.isBot, name: e.name || (e.isBot ? "BOT" : "CRIA"),
        customConfig: e.customConfig
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
