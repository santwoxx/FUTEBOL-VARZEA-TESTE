// ═══════════════════════════════════════════════════════════════════════════
// NETCODE DO CLIENTE
// ═══════════════════════════════════════════════════════════════════════════
// Tres tecnicas classicas trabalhando juntas:
//  1. Predicao local  — seu jogador responde na hora, sem esperar o servidor
//  2. Reconciliacao   — quando o snapshot chega, corrige a predicao e reaplica
//                       os inputs que o servidor ainda nao processou
//  3. Interpolacao    — os outros jogadores e a bola sao desenhados ~100ms no
//                       passado, entre dois snapshots, o que elimina tremida

import { C2S, S2C, encode, decode } from "../shared/protocol.js";

const INTERP_DELAY = 0.10;   // segundos de atraso de renderizacao
const MAX_BUFFER = 24;

export class NetClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.clientId = 0;
    this.entId = 0;
    this.team = 0;
    this.roster = [];
    this.mode = null;
    this.snapshots = [];       // {time, data}
    this.inputHistory = [];    // {seq, input, dt}
    this.seq = 0;
    this.lastAck = 0;
    this.ping = 0;
    this.serverTimeLeft = 0;
    this.score = [0, 0];
    this.ownerId = 0;
    this.frozen = false;
    this.handlers = {};
  }

  on(event, fn) { this.handlers[event] = fn; }
  emit(event, ...a) { this.handlers[event]?.(...a); }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.connected = true;
        this.startPing();
        resolve();
      };
      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => {
        this.connected = false;
        this.emit("disconnected");
      };
      this.ws.onmessage = (ev) => this.handle(decode(ev.data));
    });
  }

  send(type, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encode(type, data));
    }
  }

  startPing() {
    this.pingTimer = setInterval(() => {
      this.send(C2S.PING, { t: Date.now() });
    }, 2000);
  }

  handle(msg) {
    if (!msg) return;
    switch (msg.t) {
      case S2C.WELCOME:
        this.clientId = msg.d.id;
        this.emit("welcome", msg.d);
        break;
      case S2C.QUEUED:
        this.emit("queued", msg.d);
        break;
      case S2C.MATCH_START:
        this.entId = msg.d.youEnt;
        this.team = msg.d.youTeam;
        this.roster = msg.d.roster;
        this.mode = msg.d.mode;
        this.snapshots.length = 0;
        this.inputHistory.length = 0;
        this.emit("matchstart", msg.d);
        break;
      case S2C.SNAPSHOT:
        this.onSnapshot(msg.d);
        break;
      case S2C.GOAL:
        this.score = msg.d.score;
        this.emit("goal", msg.d);
        break;
      case S2C.MATCH_END:
        this.emit("matchend", msg.d);
        break;
      case S2C.PLAYER_LEFT:
        this.emit("playerleft", msg.d);
        break;
      case S2C.PONG:
        if (msg.d?.t) this.ping = Date.now() - msg.d.t;
        break;
      case S2C.ERROR:
        this.emit("error", msg.d);
        break;
    }
  }

  onSnapshot(d) {
    const now = performance.now() / 1000;
    this.snapshots.push({ time: now, data: d });
    if (this.snapshots.length > MAX_BUFFER) this.snapshots.shift();

    this.score = d.s;
    this.serverTimeLeft = d.t;
    this.ownerId = d.o;
    this.frozen = !!d.f;
    this.lastAck = d.ack || 0;

    // Descarta inputs ja processados pelo servidor
    this.inputHistory = this.inputHistory.filter((h) => h.seq > this.lastAck);
    this.emit("snapshot", d);
  }

  queue(mode, name) {
    this.send(C2S.HELLO, { name, customConfig: window.playerCustomConfig || null, uid: window.firebaseUid });
    this.send(C2S.QUEUE, { mode });
  }

  leave() {
    this.send(C2S.LEAVE, {});
  }

  sendInput(input, dt) {
    this.seq++;
    const packet = { ...input, seq: this.seq };
    this.inputHistory.push({ seq: this.seq, input: packet, dt });
    if (this.inputHistory.length > 120) this.inputHistory.shift();
    this.send(C2S.INPUT, packet);
    return packet;
  }

  // Estado autoritativo mais recente de uma entidade (sem interpolacao)
  latestEnt(id) {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const e = this.snapshots[i].data.e.find((x) => x[0] === id);
      if (e) return e;
    }
    return null;
  }

  /**
   * Estado interpolado do mundo para desenhar agora.
   * Retorna {ents: Map<id, {x,y,z,yaw,state,vx,vz,charge}>, ball:{x,y,z}}
   */
  interpolated() {
    const renderTime = performance.now() / 1000 - INTERP_DELAY;
    const out = { ents: new Map(), ball: null };
    if (this.snapshots.length === 0) return out;

    // Acha os dois snapshots que cercam o tempo de renderizacao
    let a = null, b = null;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].time <= renderTime) {
        a = this.snapshots[i];
        b = this.snapshots[i + 1] || null;
        break;
      }
    }
    if (!a) { a = this.snapshots[0]; b = this.snapshots[1] || null; }

    const lerp = (x, y, t) => x + (y - x) * t;
    let t = 0;
    if (b && b.time > a.time) {
      t = Math.min(1, Math.max(0, (renderTime - a.time) / (b.time - a.time)));
    }

    const bd = b ? b.data : a.data;
    out.ball = {
      x: lerp(a.data.b[0], bd.b[0], t),
      y: lerp(a.data.b[1], bd.b[1], t),
      z: lerp(a.data.b[2], bd.b[2], t)
    };

    for (const ea of a.data.e) {
      const eb = bd.e.find((x) => x[0] === ea[0]) || ea;
      // Interpolacao angular curta para o yaw (evita girar 350 graus)
      let ya = ea[4], yb = eb[4];
      let dy = ((yb - ya + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      out.ents.set(ea[0], {
        x: lerp(ea[1], eb[1], t),
        y: lerp(ea[2], eb[2], t),
        z: lerp(ea[3], eb[3], t),
        yaw: ya + dy * t,
        state: eb[5],
        vx: lerp(ea[6], eb[6], t),
        vz: lerp(ea[7], eb[7], t),
        charge: lerp(ea[8] ?? 0, eb[8] ?? 0, t)
      });
    }
    return out;
  }
}

// ─────────────────── predicao local do proprio jogador ──────────────────────
// Reproduz apenas a MOVIMENTACAO do servidor (que e o que mais afeta a sensacao
// de resposta). Acoes como chute/passe continuam sendo decididas pelo servidor.

const damp = (a, b, l, dt) => b + (a - b) * Math.exp(-l * dt);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Predictor {
  constructor(bounds) {
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vz = 0;
    this.yaw = Math.PI;
    this.bounds = bounds;   // {hw, hh}
    this.ready = false;
  }

  // Aplica um input do mesmo jeito que o servidor faz (shared/sim.js applyInput)
  applyInput(input, dt, hasBall, charging) {
    let speed = input.sprint ? 12.0 : 8.5;
    if (hasBall) speed *= 0.90;
    if (charging) speed *= 0.55;

    const mag = Math.hypot(input.dx, input.dz);
    if (mag > 0.14) {
      const nx = input.dx / mag, nz = input.dz / mag;
      const m = Math.min(1, mag);
      this.vx = damp(this.vx, nx * speed * m, 16, dt);
      this.vz = damp(this.vz, nz * speed * m, 16, dt);
      this.yaw = Math.atan2(nx, nz);
    } else {
      this.vx = damp(this.vx, 0, 13, dt);
      this.vz = damp(this.vz, 0, 13, dt);
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.x = clamp(this.x, -this.bounds.hw + 0.8, this.bounds.hw - 0.8);
    this.z = clamp(this.z, -this.bounds.hh + 0.8, this.bounds.hh - 0.8);
  }

  /**
   * Corrige a predicao com o estado autoritativo e reaplica os inputs que o
   * servidor ainda nao confirmou.
   */
  reconcile(serverEnt, pendingInputs, hasBall, charging) {
    if (!serverEnt) return;
    const sx = serverEnt[1], sy = serverEnt[2], sz = serverEnt[3];
    const svx = serverEnt[6], svz = serverEnt[7];

    if (!this.ready) {
      this.x = sx; this.y = sy; this.z = sz;
      this.vx = svx; this.vz = svz;
      this.yaw = serverEnt[4];
      this.ready = true;
      return;
    }

    // Reaplica a partir do estado do servidor
    const startX = this.x, startZ = this.z;
    this.x = sx; this.z = sz; this.y = sy;
    this.vx = svx; this.vz = svz;
    for (const h of pendingInputs) {
      this.applyInput(h.input, h.dt, hasBall, charging);
    }

    // Se o erro for pequeno, suaviza para evitar "teleporte" visivel
    const err = Math.hypot(this.x - startX, this.z - startZ);
    if (err < 1.2) {
      this.x = startX + (this.x - startX) * 0.35;
      this.z = startZ + (this.z - startZ) * 0.35;
    }
  }
}
