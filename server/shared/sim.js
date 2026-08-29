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

function findOwner(w) {
  const b = w.ball;

  // Bola chutada forte ou muito alta: ninguem conduz
  const speedSq = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
  if (b.y > 1.8 || speedSq > 280) return 0;

  // Quem ja tinha a posse mantem numa zona maior (histerese, evita piscar posse)
  if (w.ownerId) {
    const cur = getEnt(w, w.ownerId);
    if (cur && cur.state !== STATE.FALL && cur.state !== STATE.TACKLE && cur.stunned <= 0) {
      if (dist2(cur.x, cur.z, b.x, b.z) < 1.85 && b.y < 1.6) return cur.id;
    }
  }

  let best = 0, bestD = 1.65;
  for (const e of w.ents) {
    if (e.state === STATE.FALL || e.state === STATE.TACKLE || e.stunned > 0) continue;
    const d = dist2(e.x, e.z, b.x, b.z);
    if (d < bestD && b.y < 1.6) { bestD = d; best = e.id; }
  }
  return best;
}

// Cola a bola no pe de quem conduz (mesma cadencia do single-player)
function dribbleBall(w, e, dt) {
  const b = w.ball;
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
  const lead = 0.88;
  const tx = e.x + fx * lead;
  const tz = e.z + fz * lead;
  const k = smooth(24, dt);
  b.x += (tx - b.x) * k;
  b.z += (tz - b.z) * k;
  b.y = CFG.BALL_R;
  b.vx = e.vx; b.vy = e.vy; b.vz = e.vz;
}

// ──────────────────────────── acoes de jogo ────────────────────────────────

function doShoot(w, e, power, over = 0) {
  const b = w.ball;
  if (dist2(e.x, e.z, b.x, b.z) > 3.8 || b.y > 2.8) return false;
  const p = clamp(power, 0, 1);

  // Segurar alem da carga cheia nao adiciona forca: o pe passa por baixo da
  // bola. Ela sobe (loft) e perde velocidade horizontal (drag) — o chute vai
  // por cima do gol. A punicao e deterministica de proposito: o jogador precisa
  // conseguir aprender o ponto certo de soltar, e nao apostar num dado.
  const o = clamp(over, 0, 1);
  const loft = 1 + o * KICK.overLoft;
  const drag = 1 - o * KICK.overPower;

  // Direcao: mira enviada pelo cliente, com fallback para a frente do jogador
  let dx = (e.aimx ?? 0) - b.x;
  let dz = (e.aimz ?? 0) - b.z;
  let len = Math.hypot(dx, dz);
  if (len < 0.1) { dx = Math.sin(e.yaw); dz = Math.cos(e.yaw); len = 1; }
  dx /= len; dz /= len;

  b.y = Math.max(b.y, 0.30);
  const targetY = clamp(e.aimy ?? 1.2, 0.3, CFG.GOAL_H);
  const hf = targetY / CFG.GOAL_H;

  if (p >= 0.65) {
    const sp = (26 + 22 * p) * drag;
    b.vx = dx * sp; b.vz = dz * sp;
    b.vy = (2.2 + 5.2 * p) * (0.60 + 0.80 * hf) * loft;
    b.spinY = (Math.random() - 0.5) * 2.0;
    e.state = STATE.SHOT_POWER; e.act = 0.30; e.cool = 0.34;
  } else {
    const sp = (18 + 14 * p) * drag;
    b.vx = dx * sp; b.vz = dz * sp;
    b.vy = (1.8 + 3.6 * p) * (0.70 + 0.70 * hf) * loft;
    // Efeito Magnus buscando o canto
    b.spinY = ((e.aimx ?? 0) > b.x ? -1 : 1) * (5.5 + p * 4.5);
    e.state = STATE.SHOT_TECHNIQUE; e.act = 0.24; e.cool = 0.28;
  }
  e.yaw = Math.atan2(dx, dz);
  w.ownerId = 0;
  return true;
}

function doPass(w, e, power) {
  const b = w.ball;
  if (dist2(e.x, e.z, b.x, b.z) > 4.2 || b.y > 2.8) return false;
  const p = clamp(power, 0, 1);

  // Escolhe o companheiro mais alinhado com a mira/frente do jogador
  let fx = (e.aimx ?? 0) - b.x, fz = (e.aimz ?? 0) - b.z;
  let fl = Math.hypot(fx, fz);
  if (fl < 0.1) { fx = Math.sin(e.yaw); fz = Math.cos(e.yaw); fl = 1; }
  fx /= fl; fz /= fl;

  let target = null, bestDot = -2;
  for (const m of w.ents) {
    if (m.team !== e.team || m.id === e.id || m.role === "keeper") continue;
    const vx = m.x - b.x, vz = m.z - b.z;
    const l = Math.hypot(vx, vz);
    if (l < 1.2) continue;
    const dot = (vx / l) * fx + (vz / l) * fz;
    if (dot > bestDot) { bestDot = dot; target = m; }
  }

  let dx, dz, d;
  if (target && bestDot > -0.25) {
    dx = target.x - b.x; dz = target.z - b.z;
    d = Math.hypot(dx, dz); dx /= d; dz /= d;
  } else {
    dx = fx; dz = fz; d = 14;
  }

  b.y = Math.max(b.y, 0.30);
  const minSpeed = clamp(d * 0.55 + 7, 9, 20);
  const sp = minSpeed + p * 14;
  b.vx = dx * sp; b.vz = dz * sp;
  b.vy = 0.7 + p * 1.1 + Math.min(1.2, d * 0.03);
  b.spinY = 1.2;

  e.yaw = Math.atan2(dx, dz);
  e.state = STATE.PASS; e.act = 0.22 + p * 0.10; e.cool = 0.22;
  w.ownerId = 0;
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

function burstDribble(w, e, m) {
  w.ownerId = e.id;
  e.state = m.state; e.act = m.duration; e.cool = m.duration + 0.10;
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
  e.vx = fx * (9.0 + m.boost); e.vz = fz * (9.0 + m.boost);
  dribbleBall(w, e, 0.02);
  for (const o of w.ents) {
    if (o.team === e.team) continue;
    if (dist2(e.x, e.z, o.x, o.z) < 2.6) {
      o.cool = 0.8;
      let ox = o.x - e.x, oz = o.z - e.z;
      const ol = Math.hypot(ox, oz) || 1;
      o.vx += (ox / ol) * 4.2; o.vz += (oz / ol) * 4.2;
    }
  }
}

function doDribbleMove(w, e) {
  if (e.cool > 0 || e.y > 0.08) return;
  const b = w.ball;
  if (dist2(e.x, e.z, b.x, b.z) > 3.2) return;

  // Combo (drible + chute na janela) sobrepoe e dispara um movimento de vitrine
  const tickNow = w.tick;
  if (Math.abs(tickNow - (e.lastKickT ?? -1e9)) <= COMBO_WINDOW * CFG.TICK_HZ) {
    const m = COMBO_MOVES[Math.floor(Math.random() * COMBO_MOVES.length)];
    burstDribble(w, e, m);
    e.lastKickT = -1e9;
    return;
  }

  // Alterna o drible a cada toque
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

// ─────────────────────────── movimentacao ──────────────────────────────────

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
    // Combo (drible + chute na janela): vira um drible de vitrine, nao um chute
    if (dist2(e.x, e.z, w.ball.x, w.ball.z) <= 3.2 &&
        Math.abs(w.tick - (e.lastDribT ?? -1e9)) <= COMBO_WINDOW * CFG.TICK_HZ) {
      const m = COMBO_MOVES[Math.floor(Math.random() * COMBO_MOVES.length)];
      burstDribble(w, e, m);
      e.lastDribT = -1e9;
      e.prev = { ...input };
      return;
    }
    doShoot(w, e, p, over);
  }

  // Carregamento de passe
  if (input.pass) e.passCharge = Math.min(1, e.passCharge + dt * 1.6);
  if (released("pass")) {
    const p = 0.15 + e.passCharge * 0.85;
    e.passCharge = 0;
    doPass(w, e, p);
  }

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

  e.prev = { ...input };

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
  let speed = input.sprint ? 12.0 : 8.5;
  if (w.ownerId === e.id) speed *= 0.90;
  if (e.state === STATE.KICK_CHARGE) speed *= 0.55; // carregando chute anda mais devagar

  if (mag > 0.14) {
    const nx = input.dx / mag, nz = input.dz / mag;
    const m = Math.min(1, mag);
    e.vx = damp(e.vx, nx * speed * m, 16, dt);
    e.vz = damp(e.vz, nz * speed * m, 16, dt);
    e.yaw = Math.atan2(nx, nz);
    if (e.act <= 0 && e.state !== STATE.KICK_CHARGE) {
      e.state = input.sprint ? STATE.SPRINT : STATE.RUN;
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
  const input = {
    dx: 0, dz: 0, sprint: false, shoot: false, pass: false,
    tackle: false, steal: false, dribble: false, jump: false,
    aimx: 0, aimy: 1.2, aimz: atk * HH
  };

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
    if (yAt > 2.8) continue;                    // passou por cima do alcance

    let reachCenter = gk.x;
    let reach = 1.6;
    if (gk.state === STATE.DIVE_RIGHT) { reachCenter += 1.1; reach = 2.5; }
    if (gk.state === STATE.DIVE_LEFT) { reachCenter -= 1.1; reach = 2.5; }
    if (gk.state === STATE.CATCH) reach = 2.0;

    if (Math.abs(xAt - reachCenter) > reach) continue;

    // Defendeu: coloca a bola no ponto de contato
    b.x = xAt; b.y = Math.max(yAt, CFG.BALL_R); b.z = plane;
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    const hard = speed >= 20 || yAt > 1.5;
    if (hard) {
      // Espalma para o lado
      b.vz = -b.vz * 0.35;
      b.vx = (xAt >= reachCenter ? 1 : -1) * (9.5 + Math.random() * 5);
      b.vy = 3.0 + Math.random() * 1.8;
      gk.state = xAt > gk.x ? STATE.DIVE_RIGHT : STATE.DIVE_LEFT;
      gk.act = 0.75; gk.cool = 0.8;
      w.ownerId = 0;
    } else {
      // Encaixa firme
      b.vx = b.vy = b.vz = 0;
      gk.state = STATE.CATCH; gk.act = 0.9; gk.cool = 0.6; gk.kickCd = 1.2;
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

    // Fim de animacao volta para idle
    if (e.act <= 0 && e.state !== STATE.IDLE && e.state !== STATE.RUN &&
        e.state !== STATE.SPRINT && e.state !== STATE.KICK_CHARGE) {
      e.state = STATE.IDLE;
    }

    if (frozen) { e.vx = 0; e.vz = 0; continue; }

    const input = inputs.get(e.id);
    if (input && !e.isBot) {
      applyInput(w, e, input, dt);
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
        event = { type: "goal", team: scored };
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
    // [id, x, y, z, yaw, state, vx, vz, charge]
    // vx/vz sao necessarios para a reconciliacao da predicao no cliente
    e: w.ents.map((e) => [
      e.id,
      r2(e.x), r2(e.y), r2(e.z),
      r2(e.yaw),
      e.state,
      r2(e.vx), r2(e.vz),
      r2(e.charge)
    ])
  };
}
