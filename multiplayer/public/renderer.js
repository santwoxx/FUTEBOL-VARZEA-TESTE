// ═══════════════════════════════════════════════════════════════════════════
// RENDERIZACAO 3D — cena, campo, humanoides e animacao
// ═══════════════════════════════════════════════════════════════════════════
// O rig humanoide e as curvas de animacao sao portados do jogo single-player
// (neon-kick.html) para manter a mesma identidade visual e o mesmo "feel".
// A diferenca e que aqui a animacao NAO decide nada de jogo: ela apenas
// reproduz o estado que o servidor autoritativo mandou.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js";
import { CFG, HW, HH, GHW, STATE_NAME } from "../shared/constants.js";

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x130a1c);
scene.fog = new THREE.FogExp2(0x231026, 0.0065);

export const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 450);

export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

export function attachRenderer(el) {
  el.appendChild(renderer.domElement);
  resize();
}

export function resize() {
  const w = innerWidth, h = innerHeight;
  const aspect = w / h;
  const fov = THREE.MathUtils.clamp(
    THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(26)) / aspect)),
    50, 72
  );
  camera.fov = fov;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ─────────────────────────────── iluminacao ─────────────────────────────────

scene.add(new THREE.HemisphereLight(0xffdfba, 0x221328, 1.35));

const sun = new THREE.DirectionalLight(0xffaa55, 2.6);
sun.position.set(-40, 58, 32);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
{
  const s = sun.shadow.camera;
  s.left = -52; s.right = 52; s.top = 60; s.bottom = -60; s.near = 8; s.far = 180;
  s.updateProjectionMatrix();
}
scene.add(sun, sun.target);

// ──────────────────────────── textura da quadra ─────────────────────────────

const TW = CFG.W + 18, TH = CFG.H + 18;

function makeCourtTexture() {
  const cw = 2048, ch = Math.round(cw * TH / TW);
  const c = document.createElement("canvas"); c.width = cw; c.height = ch;
  const g = c.getContext("2d");
  const S = (u) => u * (cw / TW);
  const X = (x) => (x + TW / 2) * (cw / TW);
  const Z = (z) => (z + TH / 2) * (cw / TW);

  g.fillStyle = "#1e1b24";
  g.fillRect(0, 0, cw, ch);
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = Math.random() > 0.5 ? "rgba(60,50,68,0.18)" : "rgba(8,6,12,0.25)";
    g.fillRect(Math.random() * cw, Math.random() * ch, 4 + Math.random() * 16, 4 + Math.random() * 16);
  }

  const qx1 = X(-HW), qz1 = Z(-HH), qw = X(HW) - X(-HW), qh = Z(HH) - Z(-HH);
  const grad = g.createLinearGradient(qx1, qz1, qx1 + qw, qz1 + qh);
  grad.addColorStop(0, "#1a4738");
  grad.addColorStop(0.3, "#215544");
  grad.addColorStop(0.7, "#1c4a3b");
  grad.addColorStop(1, "#183e32");
  g.fillStyle = grad;
  g.fillRect(qx1, qz1, qw, qh);

  // Juntas de dilatacao
  g.strokeStyle = "rgba(10,8,14,0.40)";
  g.lineWidth = S(0.08);
  for (let x = -HW + 5; x < HW; x += 5) {
    g.beginPath(); g.moveTo(X(x), qz1); g.lineTo(X(x), qz1 + qh); g.stroke();
  }
  for (let z = -HH + 5; z < HH; z += 5) {
    g.beginPath(); g.moveTo(qx1, Z(z)); g.lineTo(qx1 + qw, Z(z)); g.stroke();
  }

  // Demarcacoes
  g.strokeStyle = "rgba(255,242,215,0.94)";
  g.lineWidth = S(0.24);
  g.lineJoin = "round";
  const rect = (x, z, w, h) => g.strokeRect(X(x), Z(z), S(w), S(h));
  rect(-HW, -HH, CFG.W, CFG.H);
  g.beginPath(); g.moveTo(X(-HW), Z(0)); g.lineTo(X(HW), Z(0)); g.stroke();
  g.beginPath(); g.arc(X(0), Z(0), S(8.0), 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(X(0), Z(0), S(0.40), 0, Math.PI * 2);
  g.fillStyle = "rgba(255,242,215,0.94)"; g.fill();

  g.save();
  g.translate(X(0), Z(0));
  g.rotate(-Math.PI / 2);
  g.font = `bold ${S(3.6)}px sans-serif`;
  g.fillStyle = "rgba(255,215,0,0.32)";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("★ CRIA 021 ★", 0, 0);
  g.restore();

  for (const s of [-1, 1]) {
    rect(-13.0, s > 0 ? HH - 11.5 : -HH, 26, 11.5);
    rect(-9.0, s > 0 ? HH - 4.6 : -HH, 18, 4.6);
    g.beginPath(); g.arc(X(0), Z(s * (HH - 8.5)), S(0.38), 0, Math.PI * 2);
    g.fillStyle = "rgba(255,242,215,0.94)"; g.fill();
    g.beginPath();
    g.arc(X(0), Z(s * (HH - 8.5)), S(7.2), s > 0 ? Math.PI : 0, s > 0 ? Math.PI * 2 : Math.PI);
    g.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

const pitch = new THREE.Mesh(
  new THREE.PlaneGeometry(TW, TH),
  new THREE.MeshStandardMaterial({ map: makeCourtTexture(), roughness: 0.82, metalness: 0.04 })
);
pitch.rotation.x = -Math.PI / 2;
pitch.receiveShadow = true;
scene.add(pitch);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(550, 550),
  new THREE.MeshStandardMaterial({ color: 0x140d1a, roughness: 0.96 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.32;
ground.receiveShadow = true;
scene.add(ground);

// Morros distantes (silhueta) — ambientacao barata e eficaz
{
  const geo = new THREE.ConeGeometry(55, 65, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0x180b22, roughness: 1 });
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(geo, mat);
    const a = (i / 6) * Math.PI * 2;
    m.position.set(Math.cos(a) * 160, 25, Math.sin(a) * 160);
    m.scale.set(1 + Math.random() * 0.5, 0.8 + Math.random() * 0.6, 1 + Math.random() * 0.5);
    scene.add(m);
  }
}

// Muros laterais + postes de luz
{
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a1d33, roughness: 0.9 });
  for (const sx of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.6, 3.2, CFG.H + 6), wallMat);
    wall.position.set(sx * (HW + 2.2), 1.6, 0);
    wall.receiveShadow = true;
    scene.add(wall);
  }
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x44444d, roughness: 0.5, metalness: 0.6 });
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff0cc, emissive: 0xffeedd, emissiveIntensity: 2.5 });
  for (const [cx, cz] of [[-(HW + 2), -(HH + 2)], [HW + 2, -(HH + 2)], [-(HW + 2), HH + 2], [HW + 2, HH + 2]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 15, 8), metalMat);
    pole.position.set(cx, 7.5, cz); pole.castShadow = true; scene.add(pole);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), bulbMat);
    bulb.position.set(cx, 14.5, cz); scene.add(bulb);
    const light = new THREE.SpotLight(0xffeedd, 220, 75, Math.PI / 3, 0.45, 1.8);
    light.position.set(cx, 14.5, cz);
    light.target.position.set(cx / 2, 0, cz / 2);
    scene.add(light, light.target);
  }
}

// ─────────────────────────────────── gols ───────────────────────────────────

function buildGoal(sign) {
  const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.3 });
  const netMat = new THREE.LineBasicMaterial({ color: 0xffd580, transparent: true, opacity: 0.45 });
  const zL = sign * HH, D = CFG.GOAL_D, Hg = CFG.GOAL_H, r = 0.15;
  const postGeo = new THREE.CylinderGeometry(r, r, Hg, 10);

  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(postGeo, postMat);
    p.position.set(sx * GHW, Hg / 2, zL); p.castShadow = true; scene.add(p);
    const back = new THREE.Mesh(postGeo, postMat);
    back.position.set(sx * GHW, Hg / 2 * 0.86, zL + sign * D);
    back.scale.y = 0.86; scene.add(back);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, CFG.GOAL_W + r * 2, 10), postMat);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, Hg, zL);
  bar.castShadow = true;
  scene.add(bar);

  const v = [];
  const push = (a, b, c, d, e, f) => v.push(a, b, c, d, e, f);
  for (let x = -GHW; x <= GHW + 0.01; x += 0.8) push(x, 0, zL + sign * D, x, Hg * 0.86, zL + sign * D);
  for (let y = 0.3; y <= Hg * 0.86; y += 0.6) push(-GHW, y, zL + sign * D, GHW, y, zL + sign * D);
  for (const sx of [-1, 1]) {
    for (let z = 0; z <= D + 0.01; z += 0.75) push(sx * GHW, 0, zL + sign * z, sx * GHW, Hg - (z / D) * (Hg * 0.14), zL + sign * z);
    for (let y = 0.4; y <= Hg; y += 0.65) push(sx * GHW, y, zL, sx * GHW, Math.min(y, Hg * 0.86), zL + sign * D);
  }
  for (let x = -GHW; x <= GHW + 0.01; x += 0.95) push(x, Hg, zL, x, Hg * 0.86, zL + sign * D);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  scene.add(new THREE.LineSegments(geo, netMat));
}
buildGoal(-1); buildGoal(1);

// ─────────────────────────────────── bola ───────────────────────────────────

function makeBallTexture() {
  const c = document.createElement("canvas"); c.width = 512; c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#faf5ec"; g.fillRect(0, 0, 512, 512);
  g.fillStyle = "#1e1822";
  const pts = [[70, 100], [256, 60], [430, 110], [140, 280], [370, 290], [70, 440], [256, 410], [440, 430], [256, 256]];
  for (const [x, y] of pts) {
    g.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2 - Math.PI / 2;
      g.lineTo(x + Math.cos(a) * 52, y + Math.sin(a) * 52);
    }
    g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const ball = new THREE.Mesh(
  new THREE.SphereGeometry(CFG.BALL_R, 24, 18),
  new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.45, metalness: 0.1 })
);
ball.castShadow = true;
scene.add(ball);

// Anel destacando o jogador local
export const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.88, 1.15, 32),
  new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
);
ring.rotation.x = -Math.PI / 2;
scene.add(ring);

// ──────────────────────── construcao do humanoide ───────────────────────────

const TEAM_COLORS = [
  { jersey: 0x18181b, shorts: 0xf4f4f5, sock: 0x18181b, cleat: 0xef4444 },  // time 0
  { jersey: 0xf4f4f5, shorts: 0x18181b, sock: 0xf4f4f5, cleat: 0x06b6d4 }   // time 1
];
const KEEPER_COLORS = [
  { jersey: 0x10b981, shorts: 0x18181b, sock: 0x10b981, cleat: 0xef4444 },
  { jersey: 0xfacc15, shorts: 0x18181b, sock: 0xfacc15, cleat: 0x06b6d4 }
];
const SKIN_TONES = [0xb07550, 0x864f30, 0xd49673, 0x543018, 0xc0815a];
const HAIR_COLORS = [0x221a14, 0x8b3224, 0x141414, 0x5a3825, 0xd4a054];

export function createHumanoid(team, role, skinIdx = 0, foot = 1, cfg = null) {
  const root = new THREE.Group();
  const pal = role === "keeper" ? KEEPER_COLORS[team] : TEAM_COLORS[team];

  const mk = (color, extra = {}) => new THREE.MeshStandardMaterial({
    color, roughness: 0.68, metalness: 0.04, flatShading: true, ...extra
  });
  const skinColorVal = cfg?.skinColor || SKIN_TONES[skinIdx % SKIN_TONES.length];
  const hairColorVal = cfg?.hairColor || HAIR_COLORS[skinIdx % HAIR_COLORS.length];
  const accessory = cfg?.accessory || 0;

  const skinMat = mk(skinColorVal, { roughness: 0.65 });
  const hairMat = mk(hairColorVal, { roughness: 0.8 });
  const jerseyMat = mk(pal.jersey, { roughness: 0.7 });
  const shortsMat = mk(pal.shorts, { roughness: 0.7 });
  const sockMat = mk(pal.sock, { roughness: 0.7 });
  const cleatMat = mk(pal.cleat, { roughness: 0.4, metalness: 0.15 });
  const soleMat = mk(0x09090b, { roughness: 0.8 });

  const hips = new THREE.Group();
  hips.position.set(0, 1.05, 0);
  root.add(hips);
  const pelvis = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.20, 0.22, 7), shortsMat);
  pelvis.scale.set(1, 1, 0.78); pelvis.position.y = -0.02; pelvis.castShadow = true;
  hips.add(pelvis);

  const spine = new THREE.Group();
  spine.position.set(0, 0.12, 0);
  hips.add(spine);
  const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.22, 0.20, 7), jerseyMat);
  waist.position.y = 0.06; waist.scale.set(1, 1, 0.78); waist.castShadow = true;
  spine.add(waist);

  const chest = new THREE.Group();
  chest.position.set(0, 0.18, 0);
  spine.add(chest);
  const chestMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.42, 8), jerseyMat);
  chestMesh.position.y = 0.17; chestMesh.scale.set(1.04, 1, 0.75); chestMesh.castShadow = true;
  chest.add(chestMesh);

  const neck = new THREE.Group();
  neck.position.set(0, 0.39, 0);
  chest.add(neck);
  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.080, 0.18, 6), skinMat);
  neckMesh.position.y = 0.06; neckMesh.castShadow = true;
  neck.add(neckMesh);

  const head = new THREE.Group();
  head.position.set(0, 0.17, 0);
  neck.add(head);

  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), skinMat);
  headMesh.scale.set(0.92, 1.15, 1.0); headMesh.castShadow = true;
  head.add(headMesh);
  
  const hairStyle = cfg?.hairStyle || "fade";

  if (hairStyle === "blackpower") {
    const afro = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), hairMat);
    afro.position.set(0, 0.10, -0.02);
    afro.castShadow = true;
    head.add(afro);
  } else if (hairStyle === "mohawk") {
    const moh = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.14, 0.32), hairMat);
    moh.position.set(0, 0.16, -0.01);
    moh.castShadow = true;
    head.add(moh);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.185, 7, 5, 0, Math.PI * 2, 0, Math.PI * 0.40), hairMat);
    cap.position.set(0, 0.05, -0.01);
    head.add(cap);
  } else if (hairStyle === "buzz") {
    const buzzCap = new THREE.Mesh(new THREE.SphereGeometry(0.186, 7, 5, 0, Math.PI * 2, 0, Math.PI * 0.42), hairMat);
    buzzCap.position.set(0, 0.06, -0.01);
    buzzCap.scale.set(0.95, 1.08, 1.02);
    head.add(buzzCap);
  } else if (hairStyle === "ponytail") {
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.19, 7, 5, 0, Math.PI * 2, 0, Math.PI * 0.48), hairMat);
    hairCap.position.set(0, 0.07, -0.01);
    hairCap.scale.set(0.96, 1.10, 1.04);
    head.add(hairCap);
    const pony = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.08, 0.16, 5), hairMat);
    pony.position.set(0, -0.05, -0.16);
    pony.rotation.x = -0.70;
    pony.castShadow = true;
    head.add(pony);
  } else if (hairStyle !== "bald") { // "fade" default
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.19, 7, 5, 0, Math.PI * 2, 0, Math.PI * 0.46), hairMat);
    hairCap.position.set(0, 0.07, -0.01);
    hairCap.scale.set(0.96, 1.10, 1.04);
    head.add(hairCap);
  }

  if (accessory === 1) { // Ninja Mask
    const mask = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.17, 0.18, 8), mk(0x111111, { roughness: 0.9 }));
    mask.position.set(0, -0.05, 0);
    head.add(mask);
  } else if (accessory === 2) { // Zorro Mask
    const zorro = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.08, 0.15), mk(0x111111, { roughness: 0.9 }));
    zorro.position.set(0, 0.06, 0.12);
    head.add(zorro);
  } else if (accessory === 3) { // Glasses
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.02), mk(0x111111, { roughness: 0.3 }));
    frame.position.set(0, 0.06, 0.18);
    head.add(frame);
  }

  const buildArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.26, 0.28, 0);
    chest.add(shoulder);
    const deltoid = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.12, 6), jerseyMat);
    deltoid.position.set(0, -0.02, 0); deltoid.rotation.z = side * 0.25; deltoid.castShadow = true;
    shoulder.add(deltoid);

    const upperArm = new THREE.Group();
    upperArm.position.set(side * 0.05, -0.04, 0);
    upperArm.rotation.z = side * -0.22;
    shoulder.add(upperArm);
    const ua = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.052, 0.30, 6), skinMat);
    ua.position.y = -0.15; ua.castShadow = true;
    upperArm.add(ua);

    const lowerArm = new THREE.Group();
    lowerArm.position.set(0, -0.30, 0);
    upperArm.add(lowerArm);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.05, 5, 5), skinMat);
    elbow.castShadow = true; lowerArm.add(elbow);
    const fa = new THREE.Mesh(new THREE.CylinderGeometry(0.050, 0.038, 0.28, 6), skinMat);
    fa.position.y = -0.14; fa.castShadow = true;
    lowerArm.add(fa);

    const hand = new THREE.Group();
    hand.position.set(0, -0.30, 0);
    lowerArm.add(hand);
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.075, 0.032), skinMat);
    palm.position.y = -0.035; palm.castShadow = true;
    hand.add(palm);

    return { shoulder: upperArm, elbow: lowerArm, handGroup: hand, side };
  };

  const buildLeg = (side) => {
    const upperLeg = new THREE.Group();
    upperLeg.position.set(side * 0.14, -0.06, 0);
    upperLeg.rotation.z = side * -0.04;
    hips.add(upperLeg);
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.105, 0.32, 6), shortsMat);
    thigh.position.y = -0.16; thigh.castShadow = true;
    upperLeg.add(thigh);
    const thighSkin = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.075, 0.20, 6), skinMat);
    thighSkin.position.y = -0.34; thighSkin.castShadow = true;
    upperLeg.add(thighSkin);

    const lowerLeg = new THREE.Group();
    lowerLeg.position.set(0, -0.46, 0);
    upperLeg.add(lowerLeg);
    const patella = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.065, 0.065), skinMat);
    patella.position.z = 0.025; patella.castShadow = true;
    lowerLeg.add(patella);
    const calf = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.050, 0.48, 6), sockMat);
    calf.position.y = -0.24; calf.castShadow = true;
    lowerLeg.add(calf);

    const foot = new THREE.Group();
    foot.position.set(0, -0.48, 0);
    lowerLeg.add(foot);
    const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.10, 0.30), cleatMat);
    cleat.position.set(0, 0.05, 0.08); cleat.castShadow = true;
    foot.add(cleat);
    const toe = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.07, 0.10), cleatMat);
    toe.position.set(0, 0.04, 0.24); toe.castShadow = true;
    foot.add(toe);
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.022, 0.34), soleMat);
    sole.position.set(0, 0.005, 0.09);
    foot.add(sole);

    return { hipJoint: upperLeg, kneeJoint: lowerLeg, footGroup: foot, side };
  };

  const armL = buildArm(-1), armR = buildArm(1);
  const legL = buildLeg(-1), legR = buildLeg(1);

  root.scale.set(1.22, 1.22, 1.22);
  scene.add(root);

  return {
    root, hips, torsoGroup: chest, headGroup: head,
    arms: [armL, armR], legs: [legL, legR],
    team, role, foot,
    // estado de animacao (dirigido pela rede)
    state: "idle", prevState: "idle", stateTime: 0,
    speed: 0, runPhase: Math.random() * Math.PI * 2, blendMove: 0,
    charge: 0
  };
}

// ─────────────────────── duracoes das animacoes ─────────────────────────────
// Espelham as duracoes usadas na simulacao (shared/sim.js) para que a animacao
// termine junto com a acao no servidor.
const DUR = {
  shot_technique: 0.24, shot_power: 0.30, pass: 0.32, tackle: 0.85,
  steal: 0.40, dribble_stepover: 0.62, jump: 0.55, header: 0.62,
  fall: 1.25, dive_left: 0.75, dive_right: 0.75, catch_center: 0.90
};

export function setCharState(c, stateIdx) {
  const name = STATE_NAME[stateIdx] || "idle";
  if (name !== c.state) {
    c.prevState = c.state;
    c.state = name;
    c.stateTime = 0;
  }
}

// ──────────────────────────── animacao ──────────────────────────────────────

export function animate(c, dt) {
  c.stateTime += dt;
  const t = performance.now() / 1000;
  const [armL, armR] = c.arms;
  const [legL, legR] = c.legs;

  const footSign = c.foot === -1 ? -1 : 1;
  const legKick = footSign === 1 ? legR : legL;
  const legPlant = footSign === 1 ? legL : legR;
  const armKick = footSign === 1 ? armR : armL;
  const armPlant = footSign === 1 ? armL : armR;

  const D = THREE.MathUtils.damp;
  const L = THREE.MathUtils.lerp;
  const st = c.state;
  const prog = (dur) => Math.min(1, c.stateTime / dur);

  // ── Carregando o chute: perna dominante armada para tras ──
  if (st === "kick_charge") {
    const ch = Math.min(1, c.charge);
    const wob = Math.sin(t * 9) * ch * 0.015;
    c.torsoGroup.rotation.x = -0.04 - ch * 0.08;
    c.torsoGroup.rotation.z = footSign * ch * 0.06;
    legPlant.hipJoint.rotation.x = -0.03 - ch * 0.05;
    legPlant.kneeJoint.rotation.x = 0.08 + ch * 0.12;
    legKick.hipJoint.rotation.x = -ch * 0.85 + wob;
    legKick.hipJoint.rotation.z = footSign * -0.04 * ch;
    legKick.kneeJoint.rotation.x = 0.10 + ch * 0.30;
    legKick.footGroup.rotation.x = -0.10 * ch;
    armPlant.shoulder.rotation.x = -0.35 - ch * 0.28;
    armKick.shoulder.rotation.x = 0.28 + ch * 0.34;
    c.hips.position.y = D(c.hips.position.y, 1.03, 10, dt);
    return;
  }

  if (st === "shot_technique" || st === "shot_power") {
    const isPower = st === "shot_power";
    const p = prog(DUR[st]);
    const windHip = isPower ? -1.10 : -0.85;
    const windKnee = isPower ? 1.45 : 1.05;
    if (p < 0.55) {
      const e = Math.sin((p / 0.55) * Math.PI * 0.5);
      c.torsoGroup.rotation.x = L(isPower ? -0.14 : 0, isPower ? 0.46 : 0.20, e);
      c.torsoGroup.rotation.z = footSign * L(isPower ? -0.12 : 0, isPower ? 0.18 : 0.24, e);
      legKick.hipJoint.rotation.x = L(windHip, isPower ? 1.72 : 1.00, e);
      legKick.hipJoint.rotation.z = footSign * L(-0.10, isPower ? -0.22 : -0.42, e);
      legKick.kneeJoint.rotation.x = L(windKnee, isPower ? 0.05 : 0.08, e);
      legKick.footGroup.rotation.x = L(-0.10, -0.20, e);
      legPlant.hipJoint.rotation.x = L(0.20, isPower ? -0.48 : -0.24, e);
      legPlant.kneeJoint.rotation.x = L(0.62, isPower ? 0.32 : 0.44, e);
      armKick.shoulder.rotation.x = L(-1.45, 1.15, e);
      armPlant.shoulder.rotation.x = L(0.95, -0.55, e);
    } else {
      const b = (p - 0.55) / 0.45;
      c.torsoGroup.rotation.x = (1 - b) * (isPower ? 0.50 : 0.20);
      c.torsoGroup.rotation.z = D(c.torsoGroup.rotation.z, 0, 12, dt);
      legKick.hipJoint.rotation.x = (1 - b) * 0.65;
      legKick.kneeJoint.rotation.x = (1 - b) * 0.10;
      legKick.footGroup.rotation.x = D(legKick.footGroup.rotation.x, 0, 12, dt);
      legPlant.hipJoint.rotation.x = (1 - b) * -0.30;
      legPlant.kneeJoint.rotation.x = (1 - b) * 0.40 + b * 0.08;
      armKick.shoulder.rotation.x = D(armKick.shoulder.rotation.x, 0, 10, dt);
      armPlant.shoulder.rotation.x = D(armPlant.shoulder.rotation.x, 0, 10, dt);
    }
    return;
  }

  if (st === "pass") {
    const p = prog(DUR.pass);
    c.torsoGroup.rotation.x = (1 - p) * 0.16;
    c.torsoGroup.rotation.z = footSign * (1 - p) * 0.10;
    legKick.hipJoint.rotation.x = Math.sin(p * Math.PI) * 0.78;
    legKick.hipJoint.rotation.z = footSign * -0.10;
    legKick.kneeJoint.rotation.x = 0.16;
    legPlant.hipJoint.rotation.x = -0.10;
    legPlant.kneeJoint.rotation.x = 0.32;
    return;
  }

  if (st === "header") {
    const p = prog(DUR.header);
    if (p < 0.34) {
      const f = p / 0.34;
      c.hips.position.y = 1.02 + f * 0.24;
      c.torsoGroup.rotation.x = -0.10 - f * 0.20;
      for (const l of [legL, legR]) {
        l.hipJoint.rotation.x = -0.35 - f * 0.25;
        l.kneeJoint.rotation.x = 0.85 + f * 0.35;
      }
      armL.shoulder.rotation.x = -1.9 * f; armR.shoulder.rotation.x = -1.9 * f;
    } else if (p < 0.58) {
      const cp = (p - 0.34) / 0.24;
      c.hips.position.y = 1.26;
      c.torsoGroup.rotation.x = L(-0.30, 0.40, cp);
      c.headGroup.rotation.x = L(-0.32, 0.24, cp);
      for (const l of [legL, legR]) { l.hipJoint.rotation.x = -0.60; l.kneeJoint.rotation.x = 1.20; }
      armL.shoulder.rotation.x = -1.9 + cp * 1.05; armL.shoulder.rotation.z = -0.55;
      armR.shoulder.rotation.x = -1.9 + cp * 1.05; armR.shoulder.rotation.z = 0.55;
    } else {
      const lp = (p - 0.58) / 0.42;
      c.hips.position.y = D(c.hips.position.y, 1.02, 14, dt);
      c.torsoGroup.rotation.x = D(c.torsoGroup.rotation.x, 0.05, 14, dt);
      c.headGroup.rotation.x = D(c.headGroup.rotation.x, 0, 14, dt);
      for (const l of [legL, legR]) {
        l.hipJoint.rotation.x = (1 - lp) * -0.30;
        l.kneeJoint.rotation.x = 0.20 + (1 - lp) * 0.65;
      }
      armL.shoulder.rotation.x = D(armL.shoulder.rotation.x, 0, 12, dt);
      armR.shoulder.rotation.x = D(armR.shoulder.rotation.x, 0, 12, dt);
    }
    return;
  }

  if (st === "jump") {
    c.root.rotation.x = D(c.root.rotation.x, -0.15, 10, dt);
    c.hips.position.y = D(c.hips.position.y, 1.15, 10, dt);
    c.torsoGroup.rotation.x = -0.2;
    legL.hipJoint.rotation.x = -0.5; legL.kneeJoint.rotation.x = 1.1;
    legR.hipJoint.rotation.x = -0.6; legR.kneeJoint.rotation.x = 1.2;
    armL.shoulder.rotation.x = -2.2; armR.shoulder.rotation.x = -2.2;
    return;
  }

  if (st === "steal") {
    const p = prog(DUR.steal);
    if (p < 0.5) {
      const f = p / 0.5;
      c.hips.position.y = D(c.hips.position.y, 0.92, 16, dt);
      c.torsoGroup.rotation.x = D(c.torsoGroup.rotation.x, 0.30, 16, dt);
      legKick.hipJoint.rotation.x = Math.sin(f * Math.PI) * 1.15;
      legKick.kneeJoint.rotation.x = 0.12;
      legPlant.hipJoint.rotation.x = -0.45; legPlant.kneeJoint.rotation.x = 0.80;
      armPlant.shoulder.rotation.x = -0.95; armKick.shoulder.rotation.x = 0.75;
    } else {
      const b = (p - 0.5) / 0.5;
      c.hips.position.y = D(c.hips.position.y, 1.05, 14, dt);
      c.torsoGroup.rotation.x = D(c.torsoGroup.rotation.x, 0.10, 14, dt);
      legKick.hipJoint.rotation.x = (1 - b) * 0.4;
      legPlant.hipJoint.rotation.x = (1 - b) * -0.2;
    }
    return;
  }

  if (st === "tackle") {
    const p = prog(DUR.tackle);
    const GLIDE_END = 0.62;
    const roll = -footSign;     // cai sobre o lado oposto ao pe dominante
    c.hips.rotation.y = 0; c.hips.rotation.z = 0;

    if (p < 0.18) {
      // Fase 1: entrada — joga o corpo pro lado e lanca a perna a frente
      const e = p / 0.18;
      c.hips.position.y = D(c.hips.position.y, 0.34, 22, dt);
      c.root.rotation.z = D(c.root.rotation.z, roll * 0.72, 20, dt);
      c.root.rotation.x = D(c.root.rotation.x, -0.30, 20, dt);
      c.torsoGroup.rotation.x = 0.30 - e * 0.10;
      c.torsoGroup.rotation.y = 0;
      c.headGroup.rotation.x = -0.18;
      legKick.hipJoint.rotation.x = 1.05 + e * 0.60; legKick.kneeJoint.rotation.x = 0.50 - e * 0.45;
      legPlant.hipJoint.rotation.x = -0.40 - e * 0.45; legPlant.kneeJoint.rotation.x = 0.65 + e * 0.70;
      legKick.footGroup.rotation.x = -0.25;
      armKick.shoulder.rotation.x = -0.55; armKick.shoulder.rotation.z = footSign * 0.45;
      armPlant.shoulder.rotation.x = -1.40; armPlant.shoulder.rotation.z = -footSign * 0.60;
      armPlant.elbow.rotation.x = -0.55;

    } else if (p < GLIDE_END) {
      // Fase 2: deslize — corpo rasteiro varrendo o gramado, perna alongando
      const g = (p - 0.18) / (GLIDE_END - 0.18);
      const sway = Math.sin(g * Math.PI);
      c.hips.position.y = D(c.hips.position.y, 0.19, 16, dt);
      c.root.rotation.z = D(c.root.rotation.z, roll * (1.06 + sway * 0.07), 13, dt);
      c.root.rotation.x = D(c.root.rotation.x, -0.38 - sway * 0.05, 13, dt);
      c.torsoGroup.rotation.x = 0.20 - g * 0.12;
      c.torsoGroup.rotation.y = footSign * sway * 0.13;
      c.headGroup.rotation.x = -0.10 + g * 0.14;
      legKick.hipJoint.rotation.x = 1.65 + g * 0.26; legKick.kneeJoint.rotation.x = Math.max(0, 0.05 - g * 0.05);
      legPlant.hipJoint.rotation.x = -0.85 + g * 0.28; legPlant.kneeJoint.rotation.x = 1.35 - g * 0.32;
      legKick.footGroup.rotation.x = -0.30 + g * 0.10;
      armKick.shoulder.rotation.x = -0.80 + sway * 0.35; armKick.shoulder.rotation.z = footSign * (0.32 + sway * 0.14);
      armPlant.shoulder.rotation.x = -1.20 - sway * 0.28; armPlant.shoulder.rotation.z = -footSign * 0.48;
      armPlant.elbow.rotation.x = -0.70 - sway * 0.30;

    } else {
      // Fase 3: levantada — recolhe as pernas e volta a ficar de pe
      const u = (p - GLIDE_END) / (1 - GLIDE_END);
      const ease = u * u * (3 - 2 * u);
      c.hips.position.y = D(c.hips.position.y, 1.05, 13, dt);
      c.root.rotation.z = D(c.root.rotation.z, 0, 12, dt);
      c.root.rotation.x = D(c.root.rotation.x, 0, 12, dt);
      c.torsoGroup.rotation.x = (1 - ease) * 0.34;
      c.torsoGroup.rotation.y = 0;
      c.headGroup.rotation.x = D(c.headGroup.rotation.x, 0, 12, dt);
      legKick.hipJoint.rotation.x = (1 - ease) * 1.15; legKick.kneeJoint.rotation.x = (1 - ease) * 0.60;
      legPlant.hipJoint.rotation.x = (1 - ease) * -0.62; legPlant.kneeJoint.rotation.x = (1 - ease) * 0.90;
      legKick.footGroup.rotation.x = (1 - ease) * -0.20;
      armKick.shoulder.rotation.x = (1 - ease) * -0.60; armKick.shoulder.rotation.z = (1 - ease) * footSign * 0.30;
      armPlant.shoulder.rotation.x = (1 - ease) * -1.05; armPlant.shoulder.rotation.z = (1 - ease) * -footSign * 0.40;
      armPlant.elbow.rotation.x = (1 - ease) * -0.60;
    }
    return;
  }

  if (st === "fall") {
    const p = prog(DUR.fall);
    if (p < 0.38) {
      c.hips.position.y = D(c.hips.position.y, 0.38, 16, dt);
      c.root.rotation.x = D(c.root.rotation.x, -1.35, 16, dt);
      legL.hipJoint.rotation.x = -1.2; legL.kneeJoint.rotation.x = 0.55;
      legR.hipJoint.rotation.x = -1.45; legR.kneeJoint.rotation.x = 0.85;
      armL.shoulder.rotation.x = -1.8; armL.shoulder.rotation.z = -0.7;
      armR.shoulder.rotation.x = -1.8; armR.shoulder.rotation.z = 0.7;
    } else if (p < 0.72) {
      c.hips.position.y = D(c.hips.position.y, 0.24, 14, dt);
      c.root.rotation.x = D(c.root.rotation.x, -1.52, 14, dt);
      legL.kneeJoint.rotation.x = 1.2; legR.kneeJoint.rotation.x = 1.4;
    } else {
      const u = (p - 0.72) / 0.28;
      c.hips.position.y = D(c.hips.position.y, 1.02, 12, dt);
      c.root.rotation.x = D(c.root.rotation.x, 0, 12, dt);
      c.root.rotation.z = D(c.root.rotation.z, 0, 12, dt);
      legL.hipJoint.rotation.x = (1 - u) * 0.4; legR.hipJoint.rotation.x = (1 - u) * 0.2;
      armL.shoulder.rotation.x = -0.3; armR.shoulder.rotation.x = -0.3;
    }
    return;
  }

  if (st === "dive_left" || st === "dive_right") {
    const dir = st === "dive_right" ? 1 : -1;
    const p = prog(DUR[st]);
    if (p < 0.4) {
      c.root.rotation.z = D(c.root.rotation.z, -dir * 1.35, 18, dt);
      c.hips.position.y = D(c.hips.position.y, 1.20, 16, dt);
      if (dir === 1) {
        armR.shoulder.rotation.x = -1.6; armR.shoulder.rotation.z = 1.6;
        armL.shoulder.rotation.x = -1.1; armL.shoulder.rotation.z = -0.6;
      } else {
        armL.shoulder.rotation.x = -1.6; armL.shoulder.rotation.z = -1.6;
        armR.shoulder.rotation.x = -1.1; armR.shoulder.rotation.z = 0.6;
      }
      legL.hipJoint.rotation.x = -0.4; legR.hipJoint.rotation.x = -0.6;
    } else if (p < 0.65) {
      c.hips.position.y = D(c.hips.position.y, 0.22, 16, dt);
      c.root.rotation.z = D(c.root.rotation.z, -dir * 1.45, 16, dt);
    } else {
      const u = (p - 0.65) / 0.35;
      c.hips.position.y = D(c.hips.position.y, 1.05, 16, dt);
      c.root.rotation.z = D(c.root.rotation.z, 0, 16, dt);
      armL.shoulder.rotation.x = (1 - u) * -0.8;
      armR.shoulder.rotation.x = (1 - u) * -0.8;
    }
    return;
  }

  if (st === "catch_center") {
    const p = prog(DUR.catch_center);
    if (p < 0.5) {
      c.hips.position.y = D(c.hips.position.y, 0.82, 14, dt);
      c.torsoGroup.rotation.x = 0.42;
      armL.shoulder.rotation.x = -1.35; armL.shoulder.rotation.z = 0.45; armL.elbow.rotation.x = -1.65;
      armR.shoulder.rotation.x = -1.35; armR.shoulder.rotation.z = -0.45; armR.elbow.rotation.x = -1.65;
      legL.kneeJoint.rotation.x = 0.75; legR.kneeJoint.rotation.x = 0.75;
    } else {
      c.hips.position.y = D(c.hips.position.y, 1.05, 14, dt);
      c.torsoGroup.rotation.x = D(c.torsoGroup.rotation.x, 0.15, 14, dt);
      c.root.rotation.z = D(c.root.rotation.z, 0, 14, dt);
      armL.shoulder.rotation.x = -0.85; armL.elbow.rotation.x = -1.3;
      armR.shoulder.rotation.x = -0.85; armR.elbow.rotation.x = -1.3;
    }
    return;
  }

  if (st === "dribble_stepover") {
    const p = prog(DUR.dribble_stepover);
    c.hips.position.y = 1.02 - Math.abs(Math.sin(p * Math.PI * 4)) * 0.05;
    c.torsoGroup.rotation.z = Math.sin(p * Math.PI * 4) * 0.28;
    c.torsoGroup.rotation.y = Math.sin(p * Math.PI * 4) * 0.32;
    c.torsoGroup.rotation.x = 0.20;
    legL.hipJoint.rotation.x = Math.sin(p * Math.PI * 4) * 0.95;
    legL.kneeJoint.rotation.x = Math.max(0.1, -Math.sin(p * Math.PI * 4) * 1.35);
    legR.hipJoint.rotation.x = -Math.sin(p * Math.PI * 4) * 0.95;
    legR.kneeJoint.rotation.x = Math.max(0.1, Math.sin(p * Math.PI * 4) * 1.35);
    armL.shoulder.rotation.x = -Math.sin(p * Math.PI * 4) * 0.85;
    armR.shoulder.rotation.x = Math.sin(p * Math.PI * 4) * 0.85;
    return;
  }

  if (st === "dance") {
    const d = c.stateTime * 9.5;
    c.hips.position.y = 1.02 + Math.abs(Math.sin(d * 2)) * 0.14;
    c.hips.rotation.z = Math.sin(d) * 0.12;
    c.torsoGroup.rotation.y = Math.sin(d) * 0.45;
    c.torsoGroup.rotation.x = Math.sin(d * 2) * 0.18;
    legL.hipJoint.rotation.x = Math.sin(d) * 0.85;
    legR.hipJoint.rotation.x = -Math.sin(d) * 0.85;
    armL.shoulder.rotation.x = Math.cos(d) * 0.9 - 0.4;
    armR.shoulder.rotation.x = -Math.cos(d) * 0.9 - 0.4;
    return;
  }

  // ── Locomocao (idle / run / sprint) ──
  c.root.rotation.x = D(c.root.rotation.x, 0, 16, dt);
  c.root.rotation.z = D(c.root.rotation.z, 0, 16, dt);

  const speed = c.speed;
  const sprintF = Math.min(1, Math.max(0, (speed - 7.0) / 5.0));
  const cadence = 4.5 + speed * 1.25;
  c.runPhase = (c.runPhase + dt * cadence) % (Math.PI * 2);
  const p2 = c.runPhase;
  c.blendMove = D(c.blendMove, speed > 0.4 ? 1 : 0, 14, dt);
  const b = c.blendMove;

  if (b > 0.01) {
    c.hips.position.y = 1.05 - Math.abs(Math.sin(p2)) * (0.045 + sprintF * 0.04) * b + Math.cos(2 * p2) * 0.025 * b;
    c.hips.rotation.z = Math.sin(p2) * (0.045 + sprintF * 0.035) * b;
    c.hips.rotation.y = -Math.sin(p2) * (0.08 + sprintF * 0.045) * b;
    c.torsoGroup.rotation.x = (0.14 + sprintF * 0.18) * b;
    c.torsoGroup.rotation.y = Math.sin(p2) * 0.14 * b;

    const phL = Math.sin(p2), phR = Math.sin(p2 + Math.PI);
    legL.hipJoint.rotation.x = phL * (0.85 + sprintF * 0.28) * b;
    legL.kneeJoint.rotation.x = Math.max(0.08, -Math.sin(p2 - 0.4) * (1.30 + sprintF * 0.35)) * b;
    legL.footGroup.rotation.x = (Math.sin(p2 + 0.3) * (0.32 + sprintF * 0.14) - 0.09) * b;
    legR.hipJoint.rotation.x = phR * (0.85 + sprintF * 0.28) * b;
    legR.kneeJoint.rotation.x = Math.max(0.08, -Math.sin(p2 + Math.PI - 0.4) * (1.30 + sprintF * 0.35)) * b;
    legR.footGroup.rotation.x = (Math.sin(p2 + Math.PI + 0.3) * (0.32 + sprintF * 0.14) - 0.09) * b;

    armL.shoulder.rotation.x = -phL * (0.80 + sprintF * 0.30) * b;
    armL.shoulder.rotation.z = -0.19 - Math.sin(p2) * 0.07 * b;
    armL.elbow.rotation.x = (-0.88 - Math.max(0, phL * 0.58) - sprintF * 0.22) * b;
    armR.shoulder.rotation.x = -phR * (0.80 + sprintF * 0.30) * b;
    armR.shoulder.rotation.z = 0.19 + Math.sin(p2) * 0.07 * b;
    armR.elbow.rotation.x = (-0.88 - Math.max(0, phR * 0.58) - sprintF * 0.22) * b;

    c.headGroup.rotation.y = -Math.sin(p2) * 0.07 * b;
    c.headGroup.rotation.x = (-0.05 - sprintF * 0.07) * b;
  }

  if (b < 0.99) {
    c.torsoGroup.rotation.x = D(c.torsoGroup.rotation.x, Math.sin(t * 1.8) * 0.035, 10, dt);
    c.torsoGroup.rotation.y = D(c.torsoGroup.rotation.y, Math.sin(t * 0.8) * 0.05, 10, dt);
    c.torsoGroup.rotation.z = D(c.torsoGroup.rotation.z, 0, 14, dt);
    c.hips.position.y = D(c.hips.position.y, 1.02 + Math.sin(t * 1.8) * 0.018, 10, dt);
    c.hips.rotation.z = D(c.hips.rotation.z, 0, 14, dt);
    c.hips.rotation.y = D(c.hips.rotation.y, 0, 14, dt);

    for (const l of [legL, legR]) {
      l.hipJoint.rotation.x = D(l.hipJoint.rotation.x, l.side * -0.04, 10, dt);
      l.hipJoint.rotation.z = D(l.hipJoint.rotation.z, l.side * 0.04, 14, dt);
      l.kneeJoint.rotation.x = D(l.kneeJoint.rotation.x, 0.06, 10, dt);
      l.footGroup.rotation.x = D(l.footGroup.rotation.x, 0, 10, dt);
      l.footGroup.rotation.z = D(l.footGroup.rotation.z, 0, 14, dt);
    }
    for (const a of [armL, armR]) {
      a.shoulder.rotation.x = D(a.shoulder.rotation.x, a.side * -Math.sin(t * 1.4) * 0.06, 10, dt);
      a.shoulder.rotation.z = D(a.shoulder.rotation.z, a.side * 0.20, 10, dt);
      a.elbow.rotation.x = D(a.elbow.rotation.x, -0.32, 10, dt);
    }
    c.headGroup.rotation.y = D(c.headGroup.rotation.y, Math.sin(t * 0.7) * 0.12, 10, dt);
    c.headGroup.rotation.x = D(c.headGroup.rotation.x, 0, 10, dt);
  }
}

export function render() {
  renderer.render(scene, camera);
}
