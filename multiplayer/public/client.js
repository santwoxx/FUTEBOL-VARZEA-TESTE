// ═══════════════════════════════════════════════════════════════════════════
// CLIENTE — entrada, camera, HUD e laco principal
// ═══════════════════════════════════════════════════════════════════════════

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js";
import { CFG, HW, HH, GHW } from "../shared/constants.js";
import { makeInput } from "../shared/protocol.js";
import {
  scene, camera, renderer, attachRenderer, resize, render,
  ball, ring, createHumanoid, animate, setCharState
} from "./renderer.js";
import { NetClient, Predictor } from "./net.js";

const $ = (s) => document.querySelector(s);

const net = new NetClient();
const predictor = new Predictor({ hw: HW, hh: HH });
const chars = new Map();      // entId -> objeto de personagem 3D

let running = false;
let last = performance.now();
let camYaw = Math.PI, camPitch = 0.28, camDist = 8.5, targetDist = 8.5;
const camFocus = new THREE.Vector3(0, 1.45, 7);
const camF = new THREE.Vector3(0, 0, -1), camR = new THREE.Vector3(1, 0, 0);
const keys = {};
let shake = 0;

const input = makeInput();

attachRenderer($("#game"));
addEventListener("resize", resize);

// ────────────────────────────── conexao ─────────────────────────────────────

function serverUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

async function connect() {
  setStatus("Conectando ao servidor...");
  try {
    await net.connect(serverUrl());
    setStatus("Conectado. Escolha um modo.");
    $("#modes").classList.remove("disabled");
  } catch (e) {
    setStatus("Falha ao conectar. O servidor esta rodando?");
  }
}

function setStatus(text) {
  const el = $("#status");
  if (el) el.textContent = text;
}

net.on("queued", (d) => {
  setStatus(`Na fila do ${d.mode} — ${d.players}/${d.capacity} jogadores. Aguardando...`);
  $("#lobby").classList.add("waiting");
});

net.on("matchstart", (d) => {
  buildRoster(d.roster);
  $("#lobby").style.display = "none";
  $("#hud").style.display = "block";
  $("#modeTag").textContent = d.mode.toUpperCase();
  running = true;
  predictor.ready = false;
  requestPointerLock();
});

net.on("goal", (d) => {
  shake = 0.55;
  flashBanner(d.team === net.team ? "GOL DO SEU TIME!" : "GOL DO ADVERSARIO");
});

net.on("matchend", (d) => {
  const mine = d.score[net.team], theirs = d.score[1 - net.team];
  flashBanner(mine > theirs ? "VITORIA!" : mine < theirs ? "DERROTA" : "EMPATE", 5000);
});

net.on("disconnected", () => {
  running = false;
  setStatus("Conexao perdida. Recarregue a pagina.");
  $("#lobby").style.display = "flex";
  $("#hud").style.display = "none";
});

net.on("error", (d) => setStatus(d.message || "Erro"));

function buildRoster(roster) {
  for (const c of chars.values()) scene.remove(c.root);
  chars.clear();
  roster.forEach((r, i) => {
    const c = createHumanoid(r.team, r.role, i, r.foot, r.customConfig);
    c.entId = r.id;
    c.isMe = r.id === net.entId;
    chars.set(r.id, c);
  });
}

function flashBanner(text, ms = 2200) {
  const el = $("#banner");
  el.textContent = text;
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = "0"; }, ms);
}

// ─────────────────────────── entrada do jogador ─────────────────────────────

// Mouse e teclado sao rastreados separadamente e combinados em gatherInput():
// se um so campo fosse usado, soltar a tecla nao limparia o clique do mouse
// (e o chute ficaria carregando para sempre).
let mouseShoot = false, mousePass = false;

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (k === " ") e.preventDefault();   // evita rolar a pagina
  if (k === "escape") document.exitPointerLock?.();
});
addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

function requestPointerLock() {
  renderer.domElement.requestPointerLock?.();
}

renderer.domElement.addEventListener("mousedown", (e) => {
  if (!running) return;
  if (document.pointerLockElement !== renderer.domElement) {
    requestPointerLock();
    return;
  }
  if (e.button === 0) mouseShoot = true;
  if (e.button === 2) mousePass = true;
});

addEventListener("mouseup", (e) => {
  if (e.button === 0) mouseShoot = false;
  if (e.button === 2) mousePass = false;
});

// Se a janela perder o foco, solta tudo (senao a acao fica presa ligada)
addEventListener("blur", () => {
  mouseShoot = mousePass = false;
  for (const k in keys) keys[k] = false;
});

addEventListener("contextmenu", (e) => e.preventDefault());

addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  const s = 0.0032;
  camYaw -= e.movementX * s;
  camPitch = THREE.MathUtils.clamp(camPitch - e.movementY * s, -0.45, 1.35);
});

addEventListener("wheel", (e) => {
  targetDist = THREE.MathUtils.clamp(targetDist + Math.sign(e.deltaY) * 0.9, 3.2, 16);
}, { passive: true });

function gatherInput() {
  let kx = 0, ky = 0;
  if (keys.a || keys.arrowleft) kx -= 1;
  if (keys.d || keys.arrowright) kx += 1;
  if (keys.w || keys.arrowup) ky -= 1;
  if (keys.s || keys.arrowdown) ky += 1;

  // Converte a entrada relativa a camera para direcao no mundo
  if (kx || ky) {
    const l = Math.hypot(kx, ky);
    kx /= l; ky /= l;
    input.dx = camF.x * -ky + camR.x * kx;
    input.dz = camF.z * -ky + camR.z * kx;
    const dl = Math.hypot(input.dx, input.dz) || 1;
    input.dx /= dl; input.dz /= dl;
  } else {
    input.dx = 0; input.dz = 0;
  }

  input.sprint = !!keys.shift;
  input.steal = !!keys.r;
  input.tackle = !!keys.q;
  input.dribble = !!(keys.v || keys.g);
  input.jump = !!keys.c;
  input.shoot = mouseShoot || !!keys[" "];
  input.pass = mousePass || !!keys.e;

  const aim = aimPoint();
  input.aimx = aim.x; input.aimy = aim.y; input.aimz = aim.z;
}

// Mira do crosshair: intersecta o plano do gol adversario, senao o chao
const aimDir = new THREE.Vector3();
const aimOut = new THREE.Vector3();
function aimPoint() {
  camera.getWorldDirection(aimDir);
  const goalZ = net.team === 0 ? -HH : HH;
  const toward = net.team === 0 ? aimDir.z < -0.01 : aimDir.z > 0.01;
  if (toward) {
    const t = (goalZ - camera.position.z) / aimDir.z;
    if (t > 0) {
      const gx = camera.position.x + t * aimDir.x;
      const gy = camera.position.y + t * aimDir.y;
      if (Math.abs(gx) <= GHW + 8 && gy >= -0.5 && gy <= CFG.GOAL_H + 4) {
        aimOut.set(
          THREE.MathUtils.clamp(gx, -GHW + 0.4, GHW - 0.4),
          THREE.MathUtils.clamp(gy, 0.4, CFG.GOAL_H - 0.2),
          goalZ
        );
        return aimOut;
      }
    }
  }
  if (aimDir.y < -0.001) {
    const t = -camera.position.y / aimDir.y;
    if (t > 0) {
      aimOut.set(camera.position.x + t * aimDir.x, 0, camera.position.z + t * aimDir.z);
      return aimOut;
    }
  }
  aimOut.copy(camera.position).addScaledVector(aimDir, 28);
  aimOut.y = THREE.MathUtils.clamp(aimOut.y, 0, CFG.GOAL_H);
  return aimOut;
}

// ──────────────────────────────── camera ────────────────────────────────────

// Vetores reaproveitados: alocar dentro do laco de render gera lixo a 60fps
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();

function updateCamera(dt, target) {
  camDist = THREE.MathUtils.damp(camDist, targetDist, 14, dt);
  tmpA.set(target.x, target.y + 1.65, target.z);
  camFocus.lerp(tmpA, 1 - Math.exp(-24 * dt));

  camF.set(Math.sin(camYaw), 0, Math.cos(camYaw));
  camR.set(-camF.z, 0, camF.x);

  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  aimDir.set(Math.sin(camYaw) * cp, sp, Math.cos(camYaw) * cp).normalize();

  tmpB.copy(camFocus).addScaledVector(aimDir, -camDist);
  if (tmpB.y < 0.45) tmpB.y = 0.45;
  camera.position.lerp(tmpB, 1 - Math.exp(-28 * dt));
  camera.lookAt(tmpA.copy(camFocus).addScaledVector(aimDir, 20));

  if (shake > 0) {
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    shake = Math.max(0, shake - dt * 1.9);
  }
}

// ───────────────────────────── laco principal ───────────────────────────────

let inputAccum = 0;
const INPUT_HZ = 30;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;

  if (running) {
    gatherInput();

    // Envia input em taxa fixa e prediz localmente
    inputAccum += dt;
    const step = 1 / INPUT_HZ;
    while (inputAccum >= step) {
      inputAccum -= step;
      net.sendInput(input, step);
      const hasBall = net.ownerId === net.entId;
      predictor.applyInput(input, step, hasBall, input.shoot);
    }

    // Reconciliacao com o ultimo estado autoritativo
    const mine = net.latestEnt(net.entId);
    if (mine) {
      predictor.reconcile(mine, net.inputHistory, net.ownerId === net.entId, input.shoot);
    }

    // Desenha o mundo interpolado
    const world = net.interpolated();
    if (world.ball) {
      ball.position.set(world.ball.x, world.ball.y, world.ball.z);
      ball.rotation.x += dt * 3;
      ball.rotation.z -= dt * 2;
    }

    for (const [id, c] of chars) {
      const s = world.ents.get(id);
      if (!s) continue;
      if (c.isMe) {
        // Meu jogador usa a posicao predita (responsiva), o resto vem da rede
        c.root.position.set(predictor.x, s.y, predictor.z);
        c.root.rotation.y = predictor.yaw;
        c.speed = Math.hypot(predictor.vx, predictor.vz);
      } else {
        c.root.position.set(s.x, s.y, s.z);
        c.root.rotation.y = s.yaw;
        c.speed = Math.hypot(s.vx, s.vz);
      }
      c.charge = s.charge;
      setCharState(c, s.state);
      animate(c, dt);
    }

    const me = chars.get(net.entId);
    if (me) {
      updateCamera(dt, me.root.position);
      ring.position.set(me.root.position.x, 0.04, me.root.position.z);
      ring.material.opacity = net.ownerId === net.entId ? 0.9 : 0.35;
    }

    updateHud();
  }

  render();
}
requestAnimationFrame(loop);

// ─────────────────────────────────── HUD ────────────────────────────────────

function updateHud() {
  const s = net.score;
  $("#score").textContent = `${s[net.team]} — ${s[1 - net.team]}`;
  const t = Math.max(0, net.serverTimeLeft);
  $("#clock").textContent =
    `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  $("#ping").textContent = `${net.ping}ms`;

  const cw = $("#crosshairWrap");
  if (input.shoot || input.pass) cw.classList.add("charging");
  else cw.classList.remove("charging");
}

// ─────────────────────────────── lobby / UI ─────────────────────────────────

document.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = ($("#nameInput").value || "CRIA").slice(0, 14);
    net.queue(btn.dataset.mode, name);
    document.querySelectorAll("[data-mode]").forEach((b) => b.classList.remove("sel"));
    btn.classList.add("sel");
  });
});

connect();
