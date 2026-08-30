// ═══════════════════════════════════════════════════════════════════════════
// SIMULACAO AUTORITATIVA HEADLESS
// ═══════════════════════════════════════════════════════════════════════════
// Este modulo NAO depende de Three.js nem do DOM: roda identico no servidor
// (Node) e no cliente (browser, para predicao local). Toda a fisica de bola,
// movimentacao, posse, chute, passe e desarme vive aqui.
//
// Os numeros foram portados do jogo single-player (frontend/index.html) para que a
// sensacao de jogo seja a mesma.

import { CFG, KICK, HW, HH, GHW, FORMATIONS, STATE } from "./constants.js";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (a, b, lambda, dt) => b + (a - b) * Math.exp(-lambda * dt);
const smooth = (l, dt) => 1 - Math.exp(-l * dt);
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

function angleLerp(a, b, t) {
  const d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

// Carrinho (slide tackle) — espelha o objeto TACKLE de frontend/index.html.
// Deslize longo: o contato e checado a cada tick enquanto o corpo esta no chao.
const TACKLE = {
  duration:  0.85,  // duracao da acao (s)
  recover:   0.35,  // trava extra depois de levantar, antes de poder agir de novo
  speed:     15.5,  // impulso inicial do deslize
  drag:       3.5,  // atrito do gramado durante o deslize
  brake:      3.2,  // multiplicador de atrito na levantada
  glideEnd:  0.62,  // fracao da acao em que o corpo sai do chao
  reachBall: 2.05,  // alcance da perna esticada na bola
  reachFoe:  1.85,  // alcance do corpo no adversario
  // Carrinho limpo: quem estava conduzindo leva um susto curto em vez de cair.
  // Nao derruba (derrubar e falta), mas tira o proximo movimento dele — e o
  // que paga o risco de se jogar no chao para tirar a bola.
  reachOwner: 2.40, // alcance do susto em quem conduzia
  stunOwner:  0.30, // atordoamento (s) de quem perdeu a bola no carrinho limpo
  shoveOwner: 3.2,  // empurrao no sentido do deslize
  stunFoul:   1.6   // tombo completo de quem sofreu falta
};

// Chapeu / lambreta. Espelhado em frontend/index.html — os dois lados precisam
// escolher o MESMO movimento para o cliente conseguir prever o drible sem
// esperar o snapshot voltar.
//
// O arco e alto de proposito: um jogador em pe tem ~1,8m, entao a bola so passa
// "por cima do marcador" se o apice ficar bem acima disso.
const CHAPEU = {
  altura:     3.60, // apice do arco acima do gramado
  avanco:     2.60, // quanto a bola avanca alem do pe durante o arco
  subida:     7.20, // velocidade vertical enquanto sobe/desce
  raioFoe:    3.60, // adversario ate aqui, em QUALQUER direcao, pede chapeu
  ballMax:    2.60, // bola dentro do alcance de controle
  ballPe:     1.20, // bola colada no pe: a direcao nao importa
  ballFrente: 0.15, // senao ela precisa estar a frente do corpo
  stun:       0.50  // atordoamento de quem levou o chapeu
};

// Chute. Espelhado em frontend/index.html.
//
// A conta antiga tirava a altura de saida de uma escala grosseira da mira
// (targetY/GOAL_H) em vez de resolver a balistica: mirando no angulo (y=3,4m) a
// bola cruzava a linha entre 1,1m e 2,9m — errava o canto por ate 2,3m e nao
// dava para escolher altura nenhuma. E o giro rendia 11 CENTIMETROS de curva em
// 18m, ou seja, curva nenhuma.
//
// Agora o chute resolve tres coisas de uma vez:
//   1. tempo de voo real ate o ponto mirado (contando o arrasto do ar);
//   2. a altura de saida que faz a bola PASSAR naquele ponto;
//   3. o quanto o efeito vai entortar a trajetoria, para sair aberto e voltar
//      no canto em vez de simplesmente errar o alvo.
const CHUTE = {
  corte:        0.65, // p a partir daqui e bomba; abaixo, colocado
  bombaBase:    27.0, // m/s da bomba, antes da carga
  bombaCarga:   23.0,
  tecBase:      21.0, // colocado: mais lento, mas cirurgico e com muita curva
  tecCarga:     12.0,
  curvaTec:     30.0, // giro maximo do colocado (direcional no disparo)
  curvaBomba:   12.0, // a bomba entorta menos: e forca, nao capricho
  aberturaMax:   0.52, // rad: teto do quanto o chute pode sair aberto para curvar
  espalhaTec:   0.10, // erro lateral (m) na linha do gol
  espalhaBomba: 0.55, // encher o pe custa pontaria
  alturaMin:     0.35, // nunca sai rasteiro demais a ponto de raspar no gramado
  // O gol so e contado 0,8m DEPOIS da linha. Uma bola que cruza subindo ja subiu
  // mais um pedaco ate la — e um chute mirado no angulo batia no travessao e
  // voltava. Resolver a balistica para este ponto (e nao para a linha) faz o
  // chute chegar na altura mirada exatamente onde o gol vale.
  folgaGol:      0.90,
  // Teto da mira: o gol tem 4m, mas acima disto a bola cruza acima da
  // trave no instante em que o gol e conferido.
  tetoMira:      3.40
};

// Arrasto do ar e decaimento do giro, iguais aos de stepBall(). Ter os dois aqui
// permite PREVER onde a bola vai passar em vez de chutar numeros.
const AR_LAMBDA   = -Math.log(0.996) * 60;   // ~0,2405 /s
const SPIN_LAMBDA = -Math.log(0.2);          // ~1,609 /s

// Tempo para percorrer `d` metros na horizontal saindo a `sp` m/s.
function tempoDeVoo(d, sp) {
  const r = 1 - (AR_LAMBDA * d) / sp;
  if (r <= 0.05) return d / sp;   // alcance curto para a conta fechada: aproxima
  return -Math.log(r) / AR_LAMBDA;
}

// Desvio lateral que o efeito Magnus acumula em `t` segundos. E a integral dupla
// da aceleracao lateral de stepBall() com o giro decaindo.
function desvioCurva(spin, sp, t) {
  const a = spin * 0.055 * sp;
  const k = SPIN_LAMBDA;
  return a * (t / k - (1 - Math.exp(-k * t)) / (k * k));
}

// Passe. Espelhado em frontend/index.html.
//
// O atrito do gramado neste jogo e altissimo (0,91^60 por segundo): uma bola que
// so rola perde ~99% da velocidade em um segundo, entao o alcance rolando e so
// v0/5,66 — um passe de 14m a meia forca morria com 6,6m de sobra. A saida nao
// foi mexer no atrito (isso mudaria chute, rebote e bola solta), e sim mandar a
// bola pelo AR na maior parte do caminho, onde o arrasto e desprezivel: ela
// cobre ~75% da distancia voando e chega quicando no pe do companheiro.
//
// Medido de 4m a 40m, em toda a faixa de carga: chega sempre, entre 0,3s e 1,7s,
// com 4 a 10 m/s de pace na chegada e pico de 0,3m a 1,8m — bola conduzida,
// nunca balao.
const PASSE = {
  base:    10.0,  // velocidade minima antes de contar a distancia
  porM:     0.60, // acrescimo por metro ate o alvo
  min:     13.0,  // piso: toque curto ainda sai com pe firme
  max:     34.0,  // teto: passe longo nao vira chute
  carga:    7.0,  // quanto a carga do botao soma na velocidade
  fracVoo:  0.75, // fracao da distancia coberta no ar
  loftMin:  1.1,  // altura minima de saida
  loftMax:  8.0   // ...e maxima, para nao virar lob
};

// Depois de tocar, o pe que bateu fica um instante sem poder reaver a bola.
// Sem isso um passe curto era engolido pelo proprio passador: doPass solta a
// posse, mas no tick seguinte a bola ainda esta a menos de 1,65m dele e abaixo
// do corte de velocidade, entao findOwner devolvia tudo — a bola nem saia do
// pe. Era isso que fazia o toque curto parecer "sem forca".
const RECUO_TOQUE = Math.round(0.30 * CFG.TICK_HZ);

// Goleiro sob controle humano. O goleiro bot defende sozinho por proximidade;
// o humano precisa MERECER a defesa — a mao so alcanca longe se ele mergulhar
// para o lado certo na hora certa.
const GOLEIRO = {
  alcanceParado:  1.25, // alcance (m) so com o corpo, sem se jogar
  alcanceMerg:    3.10, // ...mergulhando para o lado
  desloqMerg:     1.45, // deslocamento do centro do alcance no mergulho
  alturaParado:   2.10, // teto vertical sem pular
  alturaSalto:    3.30, // ...saltando (defesa no alto)
  impMerg:        9.60, // impulso lateral do mergulho
  impMergY:       4.60, // impulso vertical do mergulho
  impSalto:       7.40, // salto reto para bola alta
  durMerg:        0.78, // duracao do mergulho
  durSalto:       0.62,
  recupMerg:      0.30, // trava extra depois de cair, antes de agir de novo
  janelaEncaixe:  0.45, // tempo em que o botao de encaixar deixa a defesa virar posse
  encaixeVelMax:  30.0, // acima disso nem encaixando segura: espalma
  socoForca:      17.0, // velocidade que o soco imprime na bola
  socoAlcance:    2.60,
  durSoco:        0.40,
  areaX:          9.5,  // ate onde o goleiro pode sair do centro do gol
  areaZ:          8.0,  // ...e para a frente
  velocidade:     8.6,
  reposMao:       19.0, // arremesso com a mao
  reposPe:        27.0  // tiro de meta com o pe
};

// Pedido de passe. Vale por pouco tempo de proposito: e um pedido para AGORA,
// nao uma preferencia permanente.
const CALL = {
  ticks: Math.round(1.5 * CFG.TICK_HZ), // validade do pedido
  bonus: 1.4,   // peso na escolha do alvo do passe (o dot vai de -1 a 1)
  raio:  34     // longe demais para receber, o pedido nao conta
};

// ─────────────────────────── criacao de entidades ───────────────────────────

let nextEntId = 1;

function createEnt(team, role, foot, isBot, slot) {
  return {
    id: nextEntId++,
    team, role, foot, isBot, slot,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    yaw: team === 0 ? Math.PI : 0,
    state: STATE.IDLE,
    act: 0,        // tempo restante da animacao de acao corrente
    cool: 0,       // cooldown antes da proxima acao
    kickCd: 0,     // cooldown de chute (usado pelos bots)
    charge: 0,     // carga acumulada do chute (0..1)
    passCharge: 0,
    prev: null,    // input anterior, para deteccao de bordas
    stunned: 0,
    tackleResolved: false,
    callT: -1e9,   // tick do ultimo pedido de passe
    encaixando: 0, // janela em que a defesa vira posse em vez de rebote
    mergDir: 0,    // -1 / +1: lado do mergulho em andamento
    name: ""
  };
}

export function createWorld(teamSize, opts = {}) {
  nextEntId = 1;
  const aiKeeper = opts.aiKeeper !== false;
  const ents = [];

  for (const team of [0, 1]) {
    const form = FORMATIONS[teamSize];
    for (let i = 0; i < teamSize; i++) {
      const e = createEnt(team, "field", i % 2 === 0 ? 1 : -1, true, i);
      ents.push(e);
    }
    if (aiKeeper) {
      const gk = createEnt(team, "keeper", 1, true, -1);
      ents.push(gk);
    }
  }

  const w = {
    teamSize,
    ents,
    ball: { x: 0, y: CFG.BALL_R, z: 0, vx: 0, vy: 0, vz: 0, spinY: 0 },
    ownerId: 0,
    lastTouchEntId: 0,
    score: [0, 0],
    timeLeft: CFG.MATCH,
    running: false,
    kickoffFreeze: 0,
    lastGoal: null,
    tick: 0
  };
  resetPositions(w, 1);
  return w;
}

export function resetPositions(w, dir = 1) {
  for (const e of w.ents) {
    const form = FORMATIONS[w.teamSize];
    const sign = e.team === 0 ? 1 : -1;
    if (e.role === "keeper") {
      e.x = 0;
      e.z = sign * (HH - 2.0);
    } else {
      const p = form[e.slot] || form[0];
      e.x = p.x * sign;
      e.z = p.z * sign;
    }
    e.y = 0;
    e.vx = e.vy = e.vz = 0;
    e.yaw = e.team === 0 ? Math.PI : 0;
    e.state = STATE.IDLE;
    e.act = 0; e.cool = 0; e.charge = 0; e.passCharge = 0; e.stunned = 0;
  }
  w.ball.x = 0;
  w.ball.y = CFG.BALL_R;
  w.ball.z = dir * 1.5;
  w.ball.vx = w.ball.vy = w.ball.vz = 0;
  w.ball.spinY = 0;
  w.ownerId = 0;
  w.kickoffFreeze = 1.2;
}

export function getEnt(w, id) {
  for (const e of w.ents) if (e.id === id) return e;
  return null;
}

// ──────────────────────────── posse de bola ────────────────────────────────

// Quem acabou de bater ainda esta impedido de pegar a bola de volta?
function recuandoDoToque(w, e) {
  return w.tick < (e.semBolaAte ?? -1e9);
}

function emDrible(e) {
  return e.act > 0 && e.state >= STATE.DRIBBLE_STEPOVER && e.state <= STATE.DRIBBLE_CARRETILHA;
}

function findOwner(w) {
  const b = w.ball;

  // Quem esta executando um drible fica com a bola colada. Tem que vir ANTES do
  // corte de altura: no chapeu a bola passa dos 1,8m e, sem isto, o servidor
  // tirava a posse no meio do proprio movimento — a bola virava bola solta e o
  // marcador chapelado a recuperava. E a mesma regra do single-player.
  for (const e of w.ents) if (emDrible(e)) return e.id;

  // Bola chutada forte ou muito alta: ninguem conduz
  const speedSq = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
  if (b.y > 1.8 || speedSq > 280) return 0;

  // Quem ja tinha a posse mantem numa zona maior (histerese, evita piscar posse)
  if (w.ownerId) {
    const cur = getEnt(w, w.ownerId);
    if (cur && cur.state !== STATE.FALL && cur.state !== STATE.TACKLE && cur.stunned <= 0 &&
        !recuandoDoToque(w, cur)) {
      if (dist2(cur.x, cur.z, b.x, b.z) < 1.85 && b.y < 1.6) return cur.id;
    }
  }

  let best = 0, bestD = 1.65;
  for (const e of w.ents) {
    if (e.state === STATE.FALL || e.state === STATE.TACKLE || e.stunned > 0) continue;
    if (recuandoDoToque(w, e)) continue;
    const d = dist2(e.x, e.z, b.x, b.z);
    if (d < bestD && b.y < 1.6) { bestD = d; best = e.id; }
  }
  return best;
}

// Progresso 0→1 da acao de drible corrente.
function dribProg(e, padrao) {
  return clamp(1 - e.act / (e.dribDur || padrao), 0, 1);
}

// Cola a bola no pe de quem conduz.
//
// Cada drible tem a sua propria trajetoria de bola — as mesmas do single-player.
// Antes o servidor prendia a bola num ponto fixo a 0,88m do pe em TODOS eles: o
// cliente desenhava o chapeu subindo 3m enquanto a bola que valia (posse, chute,
// gol) continuava rolando no chao. Agora a bola da fisica e a mesma da tela.
function dribbleBall(w, e, dt) {
  w.lastTouchEntId = e.id;
  const b = w.ball;
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
  const sx = -fz, sz = fx;   // lateral do corpo

  let tx, tz, k = 24;        // alvo no gramado + rigidez do lerp, por movimento

  switch (e.state) {
    case STATE.DRIBBLE_RAINBOW: {
      // Chapeu: sobe por cima do marcador e cai ja na frente, em movimento.
      const q = dribProg(e, 0.80);
      b.x = e.x + fx * (0.30 + q * CHAPEU.avanco);
      b.z = e.z + fz * (0.30 + q * CHAPEU.avanco);
      b.y = CFG.BALL_R + Math.sin(q * Math.PI) * CHAPEU.altura;
      b.vx = fx * 6.5; b.vz = fz * 6.5;
      b.vy = Math.cos(q * Math.PI) * CHAPEU.subida;
      return;
    }
    case STATE.DRIBBLE_CARRETILHA: {
      // Sola gira a bola de lado e depois enfia ela pra frente.
      const q = dribProg(e, 0.62);
      let lead, lado;
      if (q < 0.60) {
        const r = q / 0.60;
        lead = 0.55 - r * 0.25;
        lado = Math.sin(r * Math.PI) * 0.42;
      } else {
        const r = (q - 0.60) / 0.40;
        lead = 0.30 + r * 1.55;
        lado = (1 - r) * 0.20;
      }
      tx = e.x + fx * lead + sx * lado;
      tz = e.z + fz * lead + sz * lado;
      k = 30;
      break;
    }
    case STATE.DRIBBLE_ELASTICO: {
      const q = dribProg(e, 0.55);
      const lado = q < 0.42 ? 0.75 : -0.55;
      tx = e.x + fx * 1.15 + sx * lado;
      tz = e.z + fz * 1.15 + sz * lado;
      k = 28;
      break;
    }
    case STATE.DRIBBLE_STEPOVER: {
      const q = dribProg(e, 0.70);
      const lado = Math.sin(q * Math.PI * 4) * 0.38;
      tx = e.x + fx * 1.12 + sx * lado;
      tz = e.z + fz * 1.12 + sz * lado;
      k = 28;
      break;
    }
    case STATE.DRIBBLE_ROULETTE: {
      tx = e.x + fx * 0.95;
      tz = e.z + fz * 0.95;
      k = 28;
      break;
    }
    case STATE.DRIBBLE_DRAGBACK: {
      const q = dribProg(e, 0.60);
      const lead = q < 0.45 ? 0.60 : 1.30;
      tx = e.x + fx * lead;
      tz = e.z + fz * lead;
      k = 26;
      break;
    }
    default: {
      // Goleiro com a bola segura ela no peito, nao conduz no pe.
      if (e.role === "keeper" && e.state === STATE.CATCH) {
        b.x = e.x + fx * 0.42;
        b.z = e.z + fz * 0.42;
        b.y = 1.15;
        b.vx = e.vx; b.vy = 0; b.vz = e.vz;
        return;
      }
      tx = e.x + fx * 0.88;
      tz = e.z + fz * 0.88;
      break;
    }
  }

  const a = smooth(k, dt);
  b.x += (tx - b.x) * a;
  b.z += (tz - b.z) * a;
  b.y = CFG.BALL_R;
  b.vx = e.vx; b.vy = e.vy; b.vz = e.vz;
}

// Este jogador pediu a bola ha pouco e ainda esta em condicoes de receber?
export function pedindoPasse(w, e) {
  if (w.tick - (e.callT ?? -1e9) > CALL.ticks) return false;
  if (e.state === STATE.FALL || e.stunned > 0) return false;
  return true;
}

// ──────────────────────────── acoes de jogo ────────────────────────────────

// `lat` (-1..1) e o quanto o jogador estava empurrando o direcional PARA O LADO
// no instante do disparo: e assim que se escolhe a curva, sem botao novo.
function doShoot(w, e, power, over = 0, lat = 0) {
  const b = w.ball;
  if (dist2(e.x, e.z, b.x, b.z) > 3.8 || b.y > 2.8) return false;
  w.lastTouchEntId = e.id;
  const p = clamp(power, 0, 1);
  const bomba = p >= CHUTE.corte;

  // Segurar alem da carga cheia nao adiciona forca: o pe passa por baixo da
  // bola. Ela sobe (loft) e perde velocidade horizontal (drag) — o chute vai
  // por cima do gol. A punicao e deterministica de proposito: o jogador precisa
  // conseguir aprender o ponto certo de soltar, e nao apostar num dado.
  const o = clamp(over, 0, 1);
  const loft = 1 + o * KICK.overLoft;
  const drag = 1 - o * KICK.overPower;

  // Direcao e distancia ate o ponto mirado (o crosshair do cliente)
  let dx = (e.aimx ?? 0) - b.x;
  let dz = (e.aimz ?? 0) - b.z;
  let dAlvo = Math.hypot(dx, dz);
  if (dAlvo < 0.1) { dx = Math.sin(e.yaw); dz = Math.cos(e.yaw); dAlvo = 14; }
  else { dx /= dAlvo; dz /= dAlvo; }

  b.y = Math.max(b.y, 0.30);
  const targetY = clamp(e.aimy ?? 1.2, 0.3, CHUTE.tetoMira);

  const sp = (bomba ? CHUTE.bombaBase + CHUTE.bombaCarga * p
                    : CHUTE.tecBase + CHUTE.tecCarga * p) * drag;

  // Curva escolhida no direcional. O colocado entorta muito mais que a bomba.
  const giroMax = bomba ? CHUTE.curvaBomba : CHUTE.curvaTec;
  const spin = clamp(lat, -1, 1) * giroMax;

  // Tempo real de voo ate o alvo e o desvio que o efeito vai provocar nesse
  // tempo. A direcao de saida abre para o lado CONTRARIO ao desvio, entao a
  // bola sai aberta e o efeito a traz de volta no canto mirado — que e o que
  // torna a curva util em vez de so um erro bonito.
  const dSolve = dAlvo + CHUTE.folgaGol;
  const t = tempoDeVoo(dSolve, sp);
  const desvio = desvioCurva(spin, sp, t);
  const abertura = clamp(Math.atan2(desvio, dAlvo), -CHUTE.aberturaMax, CHUTE.aberturaMax);
  const ang = Math.atan2(dx, dz) + abertura;

  // Erro do pe: a bomba e menos precisa que o colocado.
  const espalha = bomba ? CHUTE.espalhaBomba : CHUTE.espalhaTec;
  const erro = (Math.random() - 0.5) * 2 * espalha / Math.max(1, dAlvo);
  const angErro = ang + erro;
  dx = Math.sin(angErro); dz = Math.cos(angErro);

  b.vx = dx * sp; b.vz = dz * sp;
  // Altura de saida resolvida para a bola PASSAR na altura mirada: e isto que
  // faz "escolher o canto" existir de verdade.
  b.vy = Math.max(CHUTE.alturaMin, (targetY - b.y) / t + 0.5 * 18 * t) * loft;
  b.spinY = spin;

  if (bomba) { e.state = STATE.SHOT_POWER; e.act = 0.30; e.cool = 0.34; }
  else       { e.state = STATE.SHOT_TECHNIQUE; e.act = 0.24; e.cool = 0.28; }

  e.yaw = Math.atan2(dx, dz);
  w.ownerId = 0;
  e.semBolaAte = w.tick + RECUO_TOQUE;
  return true;
}

function doPass(w, e, power) {
  const b = w.ball;
  if (dist2(e.x, e.z, b.x, b.z) > 4.2 || b.y > 2.8) return false;
  w.lastTouchEntId = e.id;
  const p = clamp(power, 0, 1);

  // Escolhe o companheiro mais alinhado com a mira/frente do jogador
  let fx = (e.aimx ?? 0) - b.x, fz = (e.aimz ?? 0) - b.z;
  let fl = Math.hypot(fx, fz);
  if (fl < 0.1) { fx = Math.sin(e.yaw); fz = Math.cos(e.yaw); fl = 1; }
  fx /= fl; fz /= fl;

  let target = null, bestScore = -1e9;
  for (const m of w.ents) {
    if (m.team !== e.team || m.id === e.id || m.role === "keeper") continue;
    const vx = m.x - b.x, vz = m.z - b.z;
    const l = Math.hypot(vx, vz);
    if (l < 1.2) continue;
    // Quem pediu a bola entra na frente da mira: e uma jogada combinada, e no
    // meio da correria ninguem aponta com precisao para o companheiro.
    let sc = (vx / l) * fx + (vz / l) * fz;
    if (l < CALL.raio && pedindoPasse(w, m)) sc += CALL.bonus;
    if (sc > bestScore) { bestScore = sc; target = m; }
  }

  let dx, dz, d;
  if (target && bestScore > -0.25) {
    dx = target.x - b.x; dz = target.z - b.z;
    d = Math.hypot(dx, dz); dx /= d; dz /= d;
    target.callT = -1e9;   // pedido atendido
  } else {
    dx = fx; dz = fz; d = 14;
  }

  b.y = Math.max(b.y, 0.30);
  // Velocidade pela distancia real ate o alvo + carga do botao, e altura de
  // saida calculada para o voo cobrir PASSE.fracVoo do caminho. Ver o bloco
  // PASSE la em cima: e isso que faz a bola chegar em vez de morrer no meio.
  const sp = clamp(PASSE.base + d * PASSE.porM, PASSE.min, PASSE.max) + p * PASSE.carga;
  b.vx = dx * sp; b.vz = dz * sp;
  b.vy = clamp((PASSE.fracVoo * d * 18) / (2 * sp), PASSE.loftMin, PASSE.loftMax);
  b.spinY = 1.2;

  e.yaw = Math.atan2(dx, dz);
  e.state = STATE.PASS; e.act = 0.22 + p * 0.10; e.cool = 0.22;
  w.ownerId = 0;
  e.semBolaAte = w.tick + RECUO_TOQUE;
  return true;
}

function doSteal(w, e) {
  if (e.cool > 0 || e.act > 0 || e.y > 0.08) return;
  const b = w.ball;
  e.state = STATE.STEAL; e.act = 0.40; e.cool = 0.40;

  const d = dist2(e.x, e.z, b.x, b.z);
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
  if (d < 4.2) {
    let dx = b.x - e.x, dz = b.z - e.z;
    const l = Math.hypot(dx, dz) || 1;
    e.vx += (dx / l) * 7.5; e.vz += (dz / l) * 7.5;
    if (d < 2.9) {
      w.ownerId = e.id;
      dribbleBall(w, e, 0.016);
      // Empurra adversarios colados
      for (const o of w.ents) {
        if (o.team === e.team) continue;
        if (dist2(e.x, e.z, o.x, o.z) < 2.6) {
          o.cool = 0.8;
          let ox = o.x - e.x, oz = o.z - e.z;
          const ol = Math.hypot(ox, oz) || 1;
          o.vx += (ox / ol) * 4.5; o.vz += (oz / ol) * 4.5;
        }
      }
    }
  } else {
    e.vx = fx * 6.5; e.vz = fz * 6.5;
  }
}

function doTackle(w, e) {
  if (w.ownerId === e.id) return;
  if (e.cool > 0 || e.act > 0 || e.y > 0.08) return;

  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
  e.state = STATE.TACKLE; e.act = TACKLE.duration; e.cool = TACKLE.duration + TACKLE.recover;
  e.vx = fx * TACKLE.speed; e.vz = fz * TACKLE.speed;
  e.tackleResolved = false;

  // Contato imediato (bola/adversario ja colados); senao o deslize resolve nos
  // ticks seguintes, conforme a perna esticada alcanca o alvo.
  resolveTackleContact(w, e);
}

// Checado a cada tick do deslize: assim que a bola ou o adversario entram no
// alcance da perna esticada, o carrinho e resolvido (uma unica vez por jogada).
function resolveTackleContact(w, e) {
  if (e.tackleResolved) return;
  const b = w.ball;
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);

  // Quem estava conduzindo no momento do contato: e ele que leva o susto se a
  // bola for tirada limpa.
  const dono = w.ownerId ? getEnt(w, w.ownerId) : null;

  const dBall = dist2(e.x, e.z, b.x, b.z);
  let foe = null, dFoe = 999;
  for (const o of w.ents) {
    if (o.team === e.team) continue;
    if (o.role === "keeper") continue;   // carrinho no goleiro nao existe
    if (o.state === STATE.FALL || o.stunned > 0) continue;
    const d = dist2(e.x, e.z, o.x, o.z);
    if (d < dFoe) { dFoe = d; foe = o; }
  }
  if (dFoe > TACKLE.reachFoe) { foe = null; dFoe = 999; }

  const ballInReach = dBall < TACKLE.reachBall && b.y < 1.6;
  if (!ballInReach && !foe) return;   // ainda deslizando, nada ao alcance

  e.tackleResolved = true;
  const hitBall = ballInReach && dBall <= dFoe + 0.35;

  if (hitBall) {
    w.ownerId = e.id;
    b.vx = fx * 8.5; b.vz = fz * 8.5; b.vy = 0.8;

    // Bola tirada limpa de quem conduzia: atordoa por instantes em vez de
    // derrubar. Como findOwner() ignora quem esta atordoado, ele nao recupera a
    // bola no mesmo passo — e essa janela que faz o carrinho valer a pena.
    if (dono && dono.team !== e.team && dono.id !== e.id &&
        dono.state !== STATE.FALL && dono.stunned <= 0 &&
        dist2(e.x, e.z, dono.x, dono.z) < TACKLE.reachOwner) {
      dono.stunned = TACKLE.stunOwner;
      dono.charge = 0; dono.passCharge = 0;   // perde o chute que carregava
      dono.state = STATE.IDLE; dono.act = 0;
      dono.vx += fx * TACKLE.shoveOwner;
      dono.vz += fz * TACKLE.shoveOwner;
    }
  } else if (foe) {
    // Falta: quem cometeu fica penalizado e a bola fica parada no local
    foe.state = STATE.FALL; foe.act = TACKLE.stunFoul; foe.cool = 1.8; foe.stunned = TACKLE.stunFoul;
    let ox = foe.x - e.x, oz = foe.z - e.z;
    const ol = Math.hypot(ox, oz) || 1;
    foe.vx = (ox / ol) * 5.5; foe.vz = (oz / ol) * 5.5; foe.vy = 2.0;
    e.cool = 2.0; e.vx = 0; e.vz = 0;
    w.ownerId = 0;
    b.x = foe.x + fx * 0.5; b.z = foe.z + fz * 0.5; b.y = 0.44;
    b.vx = b.vy = b.vz = 0;
  }
}

// Dribles de rua (portados do partida rapida). O pai alterna o drible a cada
// toque — o servidor decide qual, assim o mesmo estado chega a todos os clientes.
const DRIBBLE_MOVES = [
  { key: "stepover",  state: STATE.DRIBBLE_STEPOVER,  duration: 0.70, boost: 4.8 },
  { key: "elastico",  state: STATE.DRIBBLE_ELASTICO,  duration: 0.55, boost: 5.8 },
  { key: "roulette",  state: STATE.DRIBBLE_ROULETTE,  duration: 0.75, boost: 4.5 },
  { key: "dragback",  state: STATE.DRIBBLE_DRAGBACK,  duration: 0.60, boost: 5.2 },
  { key: "rainbow",   state: STATE.DRIBBLE_RAINBOW,   duration: 0.80, boost: 6.2 },
  { key: "carretilha",state: STATE.DRIBBLE_CARRETILHA,duration: 0.62, boost: 5.6 }
];

// Combo drible+chute (qualquer ordem, janela curta) = chapéu duplo / carretilha
const COMBO_MOVES = [
  { state: STATE.DRIBBLE_RAINBOW,    duration: 0.80, boost: 6.4 },
  { state: STATE.DRIBBLE_CARRETILHA, duration: 0.62, boost: 5.6 }
];
const COMBO_WINDOW = 0.22;   // segundos de tolerancia entre drible e chute

const MOVE_CHAPEU = DRIBBLE_MOVES.find((m) => m.key === "rainbow");

function burstDribble(w, e, m) {
  w.ownerId = e.id;
  e.state = m.state; e.act = m.duration; e.cool = m.duration + 0.10;
  e.dribDur = m.duration;   // usado por dribbleBall para saber o progresso do arco
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
  e.vx = fx * (9.0 + m.boost); e.vz = fz * (9.0 + m.boost);
  dribbleBall(w, e, 0.02);

  // O chapeu joga a bola POR CIMA do marcador, entao quem foi passado fica um
  // instante sem reacao em vez de so levar um empurrao. Como findOwner() ignora
  // quem esta atordoado, ele nao pega a bola na queda do arco — e essa janela
  // que faz o movimento valer o risco. O goleiro nao entra: atordoar ele dentro
  // da area viraria gol de graca.
  const chapelou = m.state === STATE.DRIBBLE_RAINBOW;
  const raio = chapelou ? CHAPEU.raioFoe : 2.6;

  for (const o of w.ents) {
    if (o.team === e.team) continue;
    if (dist2(e.x, e.z, o.x, o.z) >= raio) continue;
    o.cool = 0.8;
    let ox = o.x - e.x, oz = o.z - e.z;
    const ol = Math.hypot(ox, oz) || 1;
    o.vx += (ox / ol) * 4.2; o.vz += (oz / ol) * 4.2;
    if (chapelou && o.role !== "keeper") {
      if (o.stunned < CHAPEU.stun) o.stunned = CHAPEU.stun;
      o.charge = 0; o.passCharge = 0;
      o.state = STATE.IDLE; o.act = 0;
    }
  }
}

// Marcador colado que justifica o chapeu: adversario dentro do raio em QUALQUER
// direcao — frente, costas ou lado — com a bola no alcance do pe. A mesma conta
// roda no cliente, que precisa prever o mesmo movimento sem esperar o snapshot.
function foeParaChapeu(w, e) {
  const b = w.ball;
  const d = dist2(e.x, e.z, b.x, b.z);
  if (d > CHAPEU.ballMax) return null;
  if (d > CHAPEU.ballPe) {
    // Longe do pe, a bola precisa estar caindo A FRENTE do jogador.
    const dot = ((b.x - e.x) * Math.sin(e.yaw) + (b.z - e.z) * Math.cos(e.yaw)) / d;
    if (dot < CHAPEU.ballFrente) return null;
  }
  let perto = null, melhor = CHAPEU.raioFoe;
  for (const o of w.ents) {
    if (o.team === e.team || o.role === "keeper") continue;
    if (o.stunned > 0 || o.state === STATE.FALL) continue;
    const dd = dist2(e.x, e.z, o.x, o.z);
    if (dd < melhor) { melhor = dd; perto = o; }
  }
  return perto;
}

function doDribbleMove(w, e) {
  if (e.cool > 0 || e.y > 0.08) return;
  const b = w.ball;
  if (dist2(e.x, e.z, b.x, b.z) > 3.2) return;

  // Combo (drible + chute na janela) sobrepoe e dispara um movimento de vitrine.
  // O sorteio sai do tick, e nao de Math.random(): assim o cliente que apertou
  // consegue prever qual movimento vai sair e desenhar ele no mesmo quadro do
  // clique, sem esperar o snapshot confirmar.
  const tickNow = w.tick;
  if (Math.abs(tickNow - (e.lastKickT ?? -1e9)) <= COMBO_WINDOW * CFG.TICK_HZ) {
    burstDribble(w, e, COMBO_MOVES[tickNow % COMBO_MOVES.length]);
    e.lastKickT = -1e9;
    return;
  }

  // Bola no pe com marcador colado (frente, costas ou lado): sai chapeu, por
  // cima dele. Fura a ordem do repertorio de proposito — e a jogada que a
  // situacao pede.
  if (foeParaChapeu(w, e)) { burstDribble(w, e, MOVE_CHAPEU); return; }

  // Sem ninguem por perto, alterna o repertorio a cada toque
  const slot = (e.dribbleSlot = (e.dribbleSlot || 0) + 1) % DRIBBLE_MOVES.length;
  burstDribble(w, e, DRIBBLE_MOVES[slot]);
}

function doJumpOrHeader(w, e) {
  if (e.y > 0.08 || e.act > 0) return;
  const b = w.ball;
  const d = dist2(e.x, e.z, b.x, b.z);
  if (b.y > 1.15 && b.y < 3.4 && d < 2.6) {
    e.state = STATE.HEADER; e.act = 0.62; e.cool = 0.35;
    e.vy = 7.6 + clamp((b.y - 0.9) * 0.85, 0, 1) * 2.4;
    const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
    e.vx += fx * 2.4; e.vz += fz * 2.4;
    e.headerDone = false;
  } else {
    e.state = STATE.JUMP; e.act = 0.55; e.vy = 7.8;
  }
}

function headerContact(w, e) {
  const b = w.ball;
  e.headerDone = true;
  let dx = (e.aimx ?? 0) - b.x, dz = (e.aimz ?? 0) - b.z;
  let l = Math.hypot(dx, dz);
  if (l < 0.1) { dx = Math.sin(e.yaw); dz = Math.cos(e.yaw); l = 1; }
  dx /= l; dz /= l;
  const sp = 14 + 10 * clamp(l / 30, 0, 1);
  b.vx = dx * sp; b.vz = dz * sp;
  b.vy = clamp(((e.aimy ?? 1.2) - b.y) * 1.0 + 1.6, -3.5, 4.8);
  b.spinY = 0;
  w.ownerId = 0;
}

// ───────────────────────── goleiro sob controle humano ─────────────────────

// Esta em acao de defesa (mergulho, salto ou soco)?
function goleiroOcupado(e) {
  return e.act > 0 && (e.state === STATE.DIVE_LEFT || e.state === STATE.DIVE_RIGHT ||
                       e.state === STATE.DIVE_HIGH || e.state === STATE.PUNCH ||
                       e.state === STATE.CATCH || e.state === STATE.THROW);
}

// Reposicao: com a bola nas maos, chuta (forte, longe) ou arremessa (rasteiro,
// preciso). Sao os mesmos botoes de chute e passe do jogador de linha.
function goleiroRepoe(w, e, comPe) {
  const b = w.ball;
  const side = e.team === 0 ? 1 : -1;
  let dx = (e.aimx ?? 0) - b.x, dz = (e.aimz ?? 0) - b.z;
  let l = Math.hypot(dx, dz);
  if (l < 0.1) { dx = 0; dz = -side; l = 1; }
  dx /= l; dz /= l;
  const sp = comPe ? GOLEIRO.reposPe : GOLEIRO.reposMao;
  b.y = Math.max(b.y, comPe ? 0.5 : 1.4);
  b.vx = dx * sp; b.vz = dz * sp;
  b.vy = comPe ? 6.0 : 2.6;
  b.spinY = 0;
  e.yaw = Math.atan2(dx, dz);
  e.state = comPe ? STATE.SHOT_TECHNIQUE : STATE.THROW;
  e.act = comPe ? 0.24 : 0.38;
  e.cool = 0.30;
  e.kickCd = 0.8;
  w.ownerId = 0;
  w.lastTouchEntId = e.id;
  e.semBolaAte = w.tick + RECUO_TOQUE;
}

function keeperInput(w, e, input, dt) {
  const prev = e.prev || {};
  const pressed = (k) => input[k] && !prev[k];
  e.aimx = input.aimx; e.aimy = input.aimy; e.aimz = input.aimz;

  const side = e.team === 0 ? 1 : -1;
  const comBola = w.ownerId === e.id;

  // Encaixar: segurar o botao abre a janela em que a defesa vira posse em vez
  // de rebote. E o que separa "espalmou" de "encaixou firme".
  if (input.steal) e.encaixando = GOLEIRO.janelaEncaixe;
  else e.encaixando = Math.max(0, e.encaixando - dt);

  if (comBola) {
    // Bola nas maos: fica parado e repoe no chute ou no passe
    e.vx = damp(e.vx, 0, 9, dt);
    e.vz = damp(e.vz, 0, 9, dt);
    if (e.kickCd <= 0 && (pressed("shoot") || pressed("pass"))) {
      goleiroRepoe(w, e, !!input.shoot);
    } else {
      dribbleBall(w, e, dt);
      if (e.act <= 0) e.state = STATE.CATCH;
    }
    guardarPrev(e, input);
    return;
  }

  if (!goleiroOcupado(e) && e.cool <= 0 && e.y <= 0.08) {
    // PULO = mergulhar. Com direcional para o lado, voa para aquele lado; sem
    // direcional, sobe reto para a bola alta. E o "pular para pegar a bola".
    if (pressed("jump")) {
      // O gol fica sempre num dos fundos (eixo Z), entao o lado do mergulho e
      // simplesmente o X do mundo — e o input ja chega em coordenadas do mundo.
      // Nao ha sinal para inverter: o jogador empurra na direcao que ve na tela.
      if (Math.abs(input.dx) > 0.35) {
        const dir = Math.sign(input.dx);
        e.mergDir = dir;
        e.mergWorld = dir;
        // A animacao usa o lado do CORPO do goleiro, que olha para o campo.
        const paraDireitaDele = side > 0 ? -dir : dir;
        e.state = paraDireitaDele > 0 ? STATE.DIVE_RIGHT : STATE.DIVE_LEFT;
        e.act = GOLEIRO.durMerg;
        e.cool = GOLEIRO.durMerg + GOLEIRO.recupMerg;
        e.vx = dir * GOLEIRO.impMerg;
        e.vy = GOLEIRO.impMergY;
      } else {
        e.mergDir = 0; e.mergWorld = 0;
        e.state = STATE.DIVE_HIGH;
        e.act = GOLEIRO.durSalto;
        e.cool = GOLEIRO.durSalto + 0.15;
        e.vy = GOLEIRO.impSalto;
      }
      guardarPrev(e, input);
      return;
    }
    // CARRINHO = soco: tira a bola da area sem risco de deixar rebote no pe.
    if (pressed("tackle")) {
      e.state = STATE.PUNCH; e.act = GOLEIRO.durSoco; e.cool = GOLEIRO.durSoco + 0.20;
      const b = w.ball;
      if (dist2(e.x, e.z, b.x, b.z) < GOLEIRO.socoAlcance && b.y < 3.4) {
        let dx = b.x - e.x, dz = b.z - e.z;
        const l = Math.hypot(dx, dz) || 1;
        // Soca para a frente e para o lado de onde a bola veio
        b.vx = (dx / l) * GOLEIRO.socoForca * 0.7 + (b.x >= 0 ? 1 : -1) * 6;
        b.vz = -side * GOLEIRO.socoForca;
        b.vy = 5.2;
        b.spinY = 0;
        w.ownerId = 0;
        w.lastTouchEntId = e.id;
        e.semBolaAte = w.tick + RECUO_TOQUE;
      }
      guardarPrev(e, input);
      return;
    }
  }

  guardarPrev(e, input);

  // Mergulho/salto em andamento: o corpo segue o impulso, sem direcao
  if (goleiroOcupado(e)) {
    e.vx = damp(e.vx, 0, e.state === STATE.PUNCH ? 8 : 2.2, dt);
    e.vz = damp(e.vz, 0, 6, dt);
    return;
  }

  // Locomocao normal, presa a area: goleiro nao vira atacante
  const mag = Math.hypot(input.dx, input.dz);
  const sp = (input.sprint ? GOLEIRO.velocidade * 1.25 : GOLEIRO.velocidade);
  if (mag > 0.14) {
    const nx = input.dx / mag, nz = input.dz / mag, m = Math.min(1, mag);
    e.vx = damp(e.vx, nx * sp * m, 16, dt);
    e.vz = damp(e.vz, nz * sp * m, 16, dt);
    e.yaw = Math.atan2(nx, nz);
    if (e.act <= 0) e.state = input.sprint ? STATE.SPRINT : STATE.RUN;
  } else {
    e.vx = damp(e.vx, 0, 13, dt);
    e.vz = damp(e.vz, 0, 13, dt);
    if (e.act <= 0) e.state = STATE.IDLE;
  }
}

// Prende o goleiro a propria area depois da integracao.
function prenderNaArea(e) {
  const side = e.team === 0 ? 1 : -1;
  const linha = side * HH;
  e.x = clamp(e.x, -GOLEIRO.areaX, GOLEIRO.areaX);
  if (side > 0) e.z = clamp(e.z, linha - GOLEIRO.areaZ, linha - 0.6);
  else e.z = clamp(e.z, linha + 0.6, linha + GOLEIRO.areaZ);
}

// ─────────────────────────── movimentacao ──────────────────────────────────

// Quanto o jogador empurrava para o LADO da linha do chute quando soltou o
// botao (-1 a 1). E o unico controle da curva: nenhum botao novo.
function lateralDoDirecional(w, e, input) {
  const mag = Math.hypot(input.dx || 0, input.dz || 0);
  if (mag < 0.20) return 0;
  const b = w.ball;
  let fx = (e.aimx ?? 0) - b.x, fz = (e.aimz ?? 0) - b.z;
  const fl = Math.hypot(fx, fz);
  if (fl < 0.1) { fx = Math.sin(e.yaw); fz = Math.cos(e.yaw); }
  else { fx /= fl; fz /= fl; }
  // Vetor lateral da linha do chute, mesma convencao do resto do jogo
  const sx = -fz, sz = fx;
  return clamp(((input.dx / mag) * sx + (input.dz / mag) * sz) * Math.min(1, mag / 0.85), -1, 1);
}

// Copia o input para e.prev SEM alocar. Antes era `e.prev = { ...input }`, um
// objeto novo por jogador por tick — 240 objetos por segundo num 4v4, so para o
// coletor recolher no meio da partida.
const BOTOES_PREV = ["shoot", "pass", "steal", "tackle", "dribble", "jump", "dance", "callPass"];
function guardarPrev(e, input) {
  const d = e.prev || (e.prev = {});
  for (let i = 0; i < BOTOES_PREV.length; i++) {
    const k = BOTOES_PREV[i];
    d[k] = !!input[k];
  }
}

function applyInput(w, e, input, dt) {
  const prev = e.prev || {};

  // Guarda a mira para as acoes usarem
  e.aimx = input.aimx; e.aimy = input.aimy; e.aimz = input.aimz;

  // Bordas de botao (press/release) detectadas no servidor
  const pressed = (k) => input[k] && !prev[k];
  const released = (k) => !input[k] && prev[k];

  // Carregamento de chute
  if (input.shoot) {
    e.charge = Math.min(KICK.max, e.charge + dt * KICK.rate);
    if (e.act <= 0 && e.state !== STATE.KICK_CHARGE && w.ownerId === e.id) {
      e.state = STATE.KICK_CHARGE;
    }
  }
  if (pressed("shoot")) e.lastKickT = w.tick;
  if (released("shoot")) {
    const held = e.charge;
    const p = 0.3 + Math.min(1, held) * 0.7;
    const over = (held - KICK.safe) / (KICK.max - KICK.safe);
    e.charge = 0;
    e.state = STATE.IDLE;
    // Componente lateral do direcional em relacao a linha do chute: empurrar
    // para o lado no momento de soltar e o que curva a bola.
    const lat = lateralDoDirecional(w, e, input);
    // Combo (drible + chute na janela): vira um drible de vitrine, nao um chute
    if (dist2(e.x, e.z, w.ball.x, w.ball.z) <= 3.2 &&
        Math.abs(w.tick - (e.lastDribT ?? -1e9)) <= COMBO_WINDOW * CFG.TICK_HZ) {
      burstDribble(w, e, COMBO_MOVES[w.tick % COMBO_MOVES.length]);
      e.lastDribT = -1e9;
      guardarPrev(e, input);
      return;
    }
    doShoot(w, e, p, over, lat);
  }

  // Carregamento de passe
  if (input.pass) e.passCharge = Math.min(1, e.passCharge + dt * 1.6);
  if (released("pass")) {
    const p = 0.15 + e.passCharge * 0.85;
    e.passCharge = 0;
    doPass(w, e, p);
  }

  // Pedir a bola. So faz sentido sem ela no pe — com a bola o botao nao faz nada.
  if (pressed("callPass") && w.ownerId !== e.id) e.callT = w.tick;

  if (pressed("steal")) doSteal(w, e);
  if (pressed("tackle")) doTackle(w, e);
  if (pressed("dribble")) { e.lastDribT = w.tick; doDribbleMove(w, e); }
  if (pressed("jump")) doJumpOrHeader(w, e);
  if (pressed("dance")) {
    if (Math.hypot(e.vx, e.vz) < 0.4 && e.act <= 0 && e.y < 0.08) {
      e.state = STATE.DANCE; e.act = 0.9; e.cool = 0.9;
      if (w.ownerId === e.id) { w.ball.vx = 0; w.ball.vz = 0; w.ownerId = 0; }
    }
  }

  guardarPrev(e, input);

  // Movimento
  const inDrib = e.state >= STATE.DRIBBLE_STEPOVER && e.state <= STATE.DRIBBLE_CARRETILHA;
  const busy = e.act > 0 && (
    e.state === STATE.TACKLE || e.state === STATE.STEAL ||
    e.state === STATE.FALL || inDrib
  );

  if (inDrib && e.act > 0) {
    // durante o drible mantem a arrancada para frente
    const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
    e.vx = damp(e.vx, fx * 13.5, 12, dt);
    e.vz = damp(e.vz, fz * 13.5, 12, dt);
    return;
  }
  if (busy || e.stunned > 0) {
    // Carrinho: pouco atrito enquanto o corpo esta no chao, freia na levantada
    let lambda = 5;
    if (e.state === STATE.TACKLE && e.act > 0) {
      const gliding = e.act > TACKLE.duration * (1 - TACKLE.glideEnd);
      lambda = gliding ? TACKLE.drag : TACKLE.drag * TACKLE.brake;
    }
    e.vx = damp(e.vx, 0, lambda, dt);
    e.vz = damp(e.vz, 0, lambda, dt);
    return;
  }

  const mag = Math.hypot(input.dx, input.dz);
  const isMoving = mag > 0.14;
  if (e.stamina === undefined) e.stamina = 100;
  if (e.isExhausted === undefined) e.isExhausted = false;

  const wantsSprint = !!input.sprint && isMoving;

  if (wantsSprint && !e.isExhausted) {
    // Drena estamina correndo (~22 por seg, dura ~4.5s de arrancada direta)
    e.stamina = Math.max(0, e.stamina - dt * 22);
    if (e.stamina <= 0) {
      e.stamina = 0;
      e.isExhausted = true;
    }
  } else {
    // Recupera estamina: mais rápido parado/andando devagar (36/s), normal em corrida (24/s)
    const recRate = isMoving ? 24 : 36;
    e.stamina = Math.min(100, e.stamina + dt * recRate);
    if (e.stamina >= 28) {
      e.isExhausted = false;
    }
  }

  const canSprint = wantsSprint && !e.isExhausted;
  let speed = canSprint ? 12.0 : 8.5;
  if (w.ownerId === e.id) speed *= 0.90;
  if (e.state === STATE.KICK_CHARGE) speed *= 0.55; // carregando chute anda mais devagar

  if (isMoving) {
    const nx = input.dx / mag, nz = input.dz / mag;
    const m = Math.min(1, mag);
    e.vx = damp(e.vx, nx * speed * m, 16, dt);
    e.vz = damp(e.vz, nz * speed * m, 16, dt);
    e.yaw = Math.atan2(nx, nz);
    if (e.act <= 0 && e.state !== STATE.KICK_CHARGE) {
      e.state = canSprint ? STATE.SPRINT : STATE.RUN;
    }
  } else {
    e.vx = damp(e.vx, 0, 13, dt);
    e.vz = damp(e.vz, 0, 13, dt);
    if (e.act <= 0 && e.state !== STATE.KICK_CHARGE) e.state = STATE.IDLE;
  }
}

// ────────────────────────────── IA dos bots ────────────────────────────────

function botThink(w, e, dt) {
  const b = w.ball;
  const atk = e.team === 0 ? -1 : 1;   // direcao do gol adversario
  // Objeto reaproveitado entre ticks pelo mesmo motivo de guardarPrev(): um
  // literal novo por bot por tick e lixo garantido a 30 Hz.
  const input = e.botInput || (e.botInput = {});
  input.dx = 0; input.dz = 0;
  input.sprint = false; input.shoot = false; input.pass = false;
  input.tackle = false; input.steal = false; input.dribble = false; input.jump = false;
  input.callPass = false;
  input.aimx = 0; input.aimy = 1.2; input.aimz = atk * HH;

  if (e.role === "keeper") {
    botKeeper(w, e, dt);
    return;
  }

  const dBall = dist2(e.x, e.z, b.x, b.z);
  const owner = w.ownerId ? getEnt(w, w.ownerId) : null;
  const weHaveBall = owner && owner.team === e.team;

  // Escolhe se este bot e o perseguidor do time
  let closest = null, cd = 1e9;
  for (const m of w.ents) {
    if (m.team !== e.team || m.role === "keeper") continue;
    const d = dist2(m.x, m.z, b.x, b.z);
    if (d < cd) { cd = d; closest = m; }
  }
  const isChaser = closest === e;

  let tx, tz;
  if (w.ownerId === e.id) {
    // Com a bola: ataca o gol
    tx = clamp(b.x * 0.35, -GHW + 2, GHW - 2);
    tz = atk * HH;
    const goalDist = Math.abs(e.z - atk * HH);
    // So finaliza de posicao razoavel, e com impressao proporcional a distancia
    // (chute de longe erra mais) — sem isso os bots faziam ~15 gols por partida.
    if (e.kickCd <= 0 && goalDist < 19 && Math.random() < dt * 2.2) {
      const spread = 1.6 + (goalDist / 19) * 5.5;
      input.aimx = clamp(
        (Math.random() - 0.5) * CFG.GOAL_W * 0.55 + (Math.random() - 0.5) * spread,
        -GHW - 2, GHW + 2
      );
      input.aimy = 0.6 + Math.random() * 2.4;
      input.aimz = atk * HH;
      e.aimx = input.aimx; e.aimy = input.aimy; e.aimz = input.aimz;
      doShoot(w, e, 0.55 + Math.random() * 0.45);
      e.kickCd = 2.2;
      return;
    }
    // Companheiro pediu a bola: toca na hora. E para isso que serve o botao —
    // o bot que conduz nao fica te ignorando enquanto voce pede por ela.
    if (e.kickCd <= 0) {
      let pede = null, melhorD = CALL.raio;
      for (const m of w.ents) {
        if (m.team !== e.team || m.id === e.id || m.role === "keeper") continue;
        if (!pedindoPasse(w, m)) continue;
        const dm = dist2(e.x, e.z, m.x, m.z);
        if (dm > 2.5 && dm < melhorD) { melhorD = dm; pede = m; }
      }
      if (pede) {
        e.aimx = pede.x; e.aimy = 1; e.aimz = pede.z;
        doPass(w, e, 0.5);
        e.kickCd = 1.0;
        return;
      }
    }

    // Passe ocasional para um companheiro melhor posicionado
    if (e.kickCd <= 0 && Math.random() < dt * 0.4) {
      e.aimx = e.x; e.aimy = 1; e.aimz = atk * HH;
      doPass(w, e, 0.5);
      e.kickCd = 1.2;
      return;
    }
  } else if (isChaser) {
    tx = b.x; tz = b.z - atk * 0.8;
    if (!weHaveBall && dBall < 2.4 && e.cool <= 0 && Math.random() < dt * 1.5) {
      doSteal(w, e);
      return;
    }
  } else {
    // Sem a bola: se posiciona apoiando
    const spread = (e.slot - (w.teamSize - 1) / 2) * 7.5;
    tx = clamp(b.x * 0.4 + spread, -HW + 4, HW - 4);
    tz = clamp(b.z + atk * (weHaveBall ? 9 : -4), -HH + 6, HH - 6);

    // Bot tambem pede a bola: se o time conduz e ele esta livre e adiantado,
    // levanta a mao. Quem conduz — humano ou bot — ve o marcador em campo.
    if (weHaveBall && owner && !pedindoPasse(w, e) && Math.random() < dt * 0.6) {
      const dDono = dist2(e.x, e.z, owner.x, owner.z);
      const ganho = (e.z - owner.z) * atk;   // esta mais adiantado que o dono?
      let livre = 1e9;
      for (const o of w.ents) {
        if (o.team === e.team) continue;
        livre = Math.min(livre, dist2(e.x, e.z, o.x, o.z));
      }
      if (dDono > 5 && dDono < 26 && livre > 4.5 && ganho > -3) e.callT = w.tick;
    }
  }

  const ddx = tx - e.x, ddz = tz - e.z;
  const l = Math.hypot(ddx, ddz);
  if (l > 0.7) {
    input.dx = ddx / l; input.dz = ddz / l;
    input.sprint = l > 12;
  }
  e.prev = e.prev || {};
  applyInput(w, e, input, dt);
}

function botKeeper(w, e, dt) {
  const b = w.ball;
  const side = e.team === 0 ? 1 : -1;
  const line = side * (HH - 1.8);
  const dz = Math.abs(b.z - side * HH);
  const advance = clamp(1 - dz / 28, 0, 1) * 2.8;

  // Antecipa onde a bola vai cruzar a linha: sem isso o goleiro persegue a
  // posicao atual e chega sempre atrasado em chutes rapidos.
  let aimX = b.x;
  if (b.vz * side > 2) {
    const tHit = Math.abs((line - b.z) / b.vz);
    aimX = b.x + b.vx * clamp(tHit, 0, 1.2);
  }
  const tx = clamp(aimX * 0.92, -GHW + 0.8, GHW - 0.8);
  const tz = line - side * advance;

  const ddx = tx - e.x, ddz = tz - e.z;
  const l = Math.hypot(ddx, ddz);
  const sp = dz < 20 ? 9.2 : 5.6;
  if (l > 0.5) {
    e.vx = damp(e.vx, (ddx / l) * sp, 5.5, dt);
    e.vz = damp(e.vz, (ddz / l) * sp, 5.5, dt);
  } else {
    e.vx = damp(e.vx, 0, 7.5, dt);
    e.vz = damp(e.vz, 0, 7.5, dt);
  }
  e.yaw = side > 0 ? Math.PI : 0;

  // Defesa: se a bola vem em direcao ao gol e esta perto, espalma/segura
  const incoming = b.vz * side > 2.2;
  if (dz < 6.5 && incoming && e.cool <= 0 && e.act <= 0) {
    const dx = b.x - e.x;
    if (Math.abs(dx) > 0.4 && Math.abs(dx) < 3.2) {
      e.state = dx > 0 ? STATE.DIVE_RIGHT : STATE.DIVE_LEFT;
      e.act = 0.75; e.cool = 0.95;
      e.vx = Math.sign(dx) * (4.5 + Math.random() * 2);
      e.vy = 4.2;
    } else if (Math.abs(dx) <= 0.9) {
      e.state = STATE.CATCH; e.act = 0.85; e.cool = 1.0;
    }
  }

  // Reposicao de bola pelo goleiro
  if (w.ownerId === e.id) {
    e.vx = 0; e.vz = 0;
    dribbleBall(w, e, dt);
    if (e.kickCd <= 0) {
      const dx = (Math.random() - 0.5) * 0.6;
      const l2 = Math.hypot(dx, 1);
      b.vx = (dx / l2) * 24; b.vz = (-side / l2) * 24; b.vy = 6.2;
      b.y = 0.8;
      e.state = STATE.SHOT_TECHNIQUE; e.act = 0.24; e.cool = 0.45; e.kickCd = 2.5;
      w.ownerId = 0;
    }
  }
}

// ────────────────────────── fisica da bola ─────────────────────────────────

// Defesa do goleiro com teste de trajetoria varrida (swept test).
// Necessario porque um chute a 48 m/s percorre ~1.6m por tick: um teste de
// proximidade simples deixaria a bola "atravessar" o goleiro entre dois frames.
function keeperSave(w, px, py, pz) {
  const b = w.ball;
  for (const gk of w.ents) {
    if (gk.role !== "keeper") continue;
    const side = gk.team === 0 ? 1 : -1;
    if (b.vz * side <= 0.5) continue;           // bola nao vai para este gol

    const plane = gk.z;
    // A bola cruzou o plano do goleiro neste tick?
    if ((pz - plane) * (b.z - plane) > 0) continue;
    const denom = b.z - pz;
    if (Math.abs(denom) < 1e-6) continue;
    const t = (plane - pz) / denom;
    if (t < 0 || t > 1) continue;

    const xAt = px + (b.x - px) * t;
    const yAt = py + (b.y - py) * t;

    let reachCenter = gk.x;
    let reach, teto;
    const mergulhando = gk.state === STATE.DIVE_LEFT || gk.state === STATE.DIVE_RIGHT;

    if (gk.isBot) {
      // Goleiro da maquina: defende por proximidade, como sempre defendeu.
      reach = 1.6; teto = 2.8;
      if (gk.state === STATE.DIVE_RIGHT) { reachCenter += 1.1; reach = 2.5; }
      if (gk.state === STATE.DIVE_LEFT) { reachCenter -= 1.1; reach = 2.5; }
      if (gk.state === STATE.CATCH) reach = 2.0;
    } else {
      // Goleiro humano: parado, so pega o que vem em cima dele. O alcance longo
      // e o alto so existem se ele tiver se jogado para o lado certo — e essa
      // escolha que faz a posicao valer a pena.
      reach = GOLEIRO.alcanceParado;
      teto = GOLEIRO.alturaParado;
      if (mergulhando) {
        reach = GOLEIRO.alcanceMerg;
        reachCenter += (gk.mergWorld || 0) * GOLEIRO.desloqMerg;
        teto = GOLEIRO.alturaSalto;
      } else if (gk.state === STATE.DIVE_HIGH || gk.state === STATE.PUNCH) {
        reach = GOLEIRO.alcanceParado + 0.55;
        teto = GOLEIRO.alturaSalto;
      }
      // O corpo no ar acompanha: a altura da mao sobe com o proprio salto
      teto += gk.y;
    }

    if (yAt > teto) continue;                   // passou por cima do alcance
    if (Math.abs(xAt - reachCenter) > reach) continue;

    // Defendeu: coloca a bola no ponto de contato
    b.x = xAt; b.y = Math.max(yAt, CFG.BALL_R); b.z = plane;
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    // O bot decide pela dificuldade da bola. O humano decide com o botao de
    // encaixar: segurou na hora do contato e a bola nao veio absurda, encaixou.
    const hard = gk.isBot
      ? (speed >= 20 || yAt > 1.5)
      : !(gk.encaixando > 0 && speed < GOLEIRO.encaixeVelMax);
    if (hard) {
      // Espalma para o lado
      b.vz = -b.vz * 0.35;
      b.vx = (xAt >= reachCenter ? 1 : -1) * (9.5 + Math.random() * 5);
      b.vy = 3.0 + Math.random() * 1.8;
      if (gk.isBot || !(mergulhando || gk.state === STATE.DIVE_HIGH)) {
        gk.state = xAt > gk.x ? STATE.DIVE_RIGHT : STATE.DIVE_LEFT;
        gk.act = 0.75; gk.cool = 0.8;
      }
      w.ownerId = 0;
    } else {
      // Encaixa firme
      b.vx = b.vy = b.vz = 0;
      gk.state = STATE.CATCH; gk.act = 0.9; gk.cool = 0.6;
      gk.kickCd = gk.isBot ? 1.2 : 0.5;   // o humano repoe quando quiser
      gk.encaixando = 0;
      w.ownerId = gk.id;
    }
    return true;
  }
  return false;
}

function stepBall(w, dt) {
  const b = w.ball;
  const px = b.x, py = b.y, pz = b.z;
  b.vy -= 18 * dt;

  // Efeito Magnus (curva) — a bola gira e a trajetoria acompanha
  if (Math.abs(b.spinY) > 0.01) {
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > 0.5) {
      const mag = b.spinY * 0.055;
      const nx = -b.vz / sp, nz = b.vx / sp;
      b.vx += nx * mag * sp * dt;
      b.vz += nz * mag * sp * dt;
    }
    b.spinY *= Math.pow(0.2, dt);
  }

  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;

  // Defesa do goleiro antes de qualquer teste de gol
  if (keeperSave(w, px, py, pz)) return -1;

  if (b.y < CFG.BALL_R) {
    b.y = CFG.BALL_R;
    if (b.vy < -0.9) b.vy *= -0.48; else b.vy = 0;
    const f = Math.pow(0.91, dt * 60);
    b.vx *= f; b.vz *= f;
  } else {
    const f = Math.pow(0.996, dt * 60);
    b.vx *= f; b.vz *= f;
  }

  // Teto da gaiola: o chute furado volta para o jogo em vez de sumir da tela.
  const ceil = CFG.CEIL - CFG.BALL_R;
  if (b.y > ceil) {
    b.y = ceil;
    if (b.vy > 0) b.vy *= -0.55;
    b.vx *= 0.86; b.vz *= 0.86;   // a rede no alto tira velocidade
    b.spinY *= 0.5;
  }

  // Laterais
  const bx = HW - CFG.BALL_R;
  if (Math.abs(b.x) > bx) {
    b.x = Math.sign(b.x) * bx;
    b.vx *= -0.62;
    b.spinY *= 0.5;
  }

  // Fundos / gols
  const bz = HH - CFG.BALL_R;
  if (Math.abs(b.z) > bz) {
    const inMouth = Math.abs(b.x) < GHW - 0.35 && b.y < CFG.GOAL_H - 0.35;
    if (inMouth) {
      const past = Math.abs(b.z) - HH;
      const slow = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz < 2.2;
      if (past > 0.8 || (past > 0.1 && slow)) {
        // Gol: quem defende esse lado sofre. Time 0 defende z>0.
        const scoringTeam = b.z < 0 ? 0 : 1;
        return scoringTeam;
      }
    } else {
      b.z = Math.sign(b.z) * bz;
      b.vz *= -0.62;
    }
  }
  return -1;
}

// ───────────────────────── colisao entre jogadores ─────────────────────────

function resolveCollisions(w) {
  const R = 0.62;
  for (let i = 0; i < w.ents.length; i++) {
    for (let j = i + 1; j < w.ents.length; j++) {
      const a = w.ents[i], c = w.ents[j];
      if (a.y > 1.2 || c.y > 1.2) continue;
      let dx = c.x - a.x, dz = c.z - a.z;
      let d = Math.hypot(dx, dz);
      if (d > 0.0001 && d < R * 2) {
        const push = (R * 2 - d) * 0.5;
        dx /= d; dz /= d;
        a.x -= dx * push; a.z -= dz * push;
        c.x += dx * push; c.z += dz * push;
      }
    }
  }
}

// ───────────────────────────── passo principal ─────────────────────────────

/**
 * Avanca a simulacao em dt segundos.
 * @param w mundo
 * @param dt passo de tempo (fixo no servidor: 1/TICK_HZ)
 * @param inputs Map<entId, input> com os comandos dos jogadores humanos
 * @returns evento ocorrido neste passo ({type:'goal',team} | {type:'end'} | null)
 */
export function step(w, dt, inputs) {
  w.tick++;
  let event = null;

  if (w.kickoffFreeze > 0) {
    w.kickoffFreeze -= dt;
  } else if (w.running) {
    w.timeLeft -= dt;
    if (w.timeLeft <= 0) {
      w.timeLeft = 0;
      w.running = false;
      return { type: "end" };
    }
  }

  const frozen = w.kickoffFreeze > 0;

  for (const e of w.ents) {
    e.cool = Math.max(0, e.cool - dt);
    e.act = Math.max(0, e.act - dt);
    e.kickCd = Math.max(0, e.kickCd - dt);
    e.stunned = Math.max(0, e.stunned - dt);
    if (e.role === "keeper" && e.isBot) e.encaixando = 0;

    // Fim de animacao volta para idle
    if (e.act <= 0 && e.state !== STATE.IDLE && e.state !== STATE.RUN &&
        e.state !== STATE.SPRINT && e.state !== STATE.KICK_CHARGE) {
      e.state = STATE.IDLE;
    }

    if (frozen) { e.vx = 0; e.vz = 0; continue; }

    const input = inputs.get(e.id);
    if (input && !e.isBot) {
      if (e.role === "keeper") keeperInput(w, e, input, dt);
      else applyInput(w, e, input, dt);
    } else {
      botThink(w, e, dt);
    }

    // Integracao
    e.vy -= 23 * dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.z += e.vz * dt;
    e.x = clamp(e.x, -HW + 0.8, HW - 0.8);
    e.z = clamp(e.z, -HH + 0.8, HH - 0.8);
    if (e.role === "keeper" && !e.isBot) prenderNaArea(e);
    if (e.y <= 0) {
      if (e.state === STATE.JUMP && e.vy < 0) { e.state = STATE.IDLE; e.act = 0; }
      e.y = 0; e.vy = 0;
    }

    // A perna varre o gramado o deslize inteiro: contato checado a cada tick
    if (e.state === STATE.TACKLE && e.act > 0) resolveTackleContact(w, e);

    // Contato do cabeceio
    if (e.state === STATE.HEADER && !e.headerDone) {
      const b = w.ball;
      const headY = e.y + 1.60;
      if (dist2(e.x, e.z, b.x, b.z) < 1.10 && b.y > 0.6 && Math.abs(b.y - headY) < 0.9) {
        headerContact(w, e);
      }
    }
  }

  resolveCollisions(w);

  if (!frozen) {
    w.ownerId = findOwner(w);
    if (w.ownerId) {
      const o = getEnt(w, w.ownerId);
      if (o) dribbleBall(w, o, dt);
    } else {
      const scored = stepBall(w, dt);
      if (scored >= 0) {
        w.score[scored]++;
        event = { type: "goal", team: scored, scorerEntId: w.lastTouchEntId || 0 };
        resetPositions(w, scored === 0 ? -1 : 1);
      }
    }
  }

  return event;
}

// ─────────────────────── serializacao de snapshot ──────────────────────────

// Arredonda para 2 casas: corta ~40% do tamanho do JSON sem diferenca visivel
const r2 = (v) => Math.round(v * 100) / 100;

export function serialize(w) {
  return {
    k: w.tick,
    s: w.score,
    t: Math.ceil(w.timeLeft),
    o: w.ownerId,
    f: w.kickoffFreeze > 0 ? 1 : 0,
    b: [r2(w.ball.x), r2(w.ball.y), r2(w.ball.z), r2(w.ball.vx), r2(w.ball.vy), r2(w.ball.vz)],
    // [id, x, y, z, yaw, state, vx, vz, charge, pediuPasse]
    // vx/vz sao necessarios para a reconciliacao da predicao no cliente
    e: w.ents.map((e) => [
      e.id,
      r2(e.x), r2(e.y), r2(e.z),
      r2(e.yaw),
      e.state,
      r2(e.vx), r2(e.vz),
      r2(e.charge),
      pedindoPasse(w, e) ? 1 : 0
    ])
  };
}
