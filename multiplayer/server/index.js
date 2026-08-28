// Servidor HTTP (arquivos estaticos do cliente) + WebSocket (partidas).
// Um unico processo Node serve o jogo e roda as simulacoes — e o que permite
// hospedar tudo num servico gratuito como o Render.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { MODES } from "../shared/constants.js";
import { C2S, S2C, encode, decode } from "../shared/protocol.js";
import { Room } from "./room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const SHARED = path.join(ROOT, "shared");
const PORT = process.env.PORT || 8080;

// ───────────────────────────── HTTP estatico ────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  if (!p.startsWith(base)) return null;   // bloqueia path traversal (../../etc)
  return p;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: clients.size }));
    return;
  }

  if (pathname === "/rooms") {
    const list = [];
    for (const r of rooms.values()) {
      // Lista apenas salas abertas que ainda nao comecaram
      if (!r.started) list.push(r.publicInfo());
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(list));
    return;
  }

  if (pathname === "/") pathname = "/index.html";

  // /shared/* vem da pasta compartilhada; o resto vem de /public
  let filePath;
  if (pathname.startsWith("/shared/")) {
    filePath = safeJoin(SHARED, pathname.slice("/shared/".length));
  } else {
    filePath = safeJoin(PUBLIC, pathname);
  }

  if (!filePath) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 — arquivo nao encontrado");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// ──────────────────────────── WebSocket / salas ─────────────────────────────

const wss = new WebSocketServer({ server });
const rooms = new Map();      // roomId -> Room
const clients = new Map();    // clientId -> client
let nextClientId = 1;

function findOrCreateRoom(mode) {
  // Procura uma sala do mesmo modo que ainda nao encheu e nao comecou
  for (const r of rooms.values()) {
    if (r.mode === mode && !r.isFull && !r.private) return r;
  }
  const room = new Room(mode, { onEmpty: (r) => rooms.delete(r.id) });
  rooms.set(room.id, room);
  return room;
}

function findRoomById(id) {
  return rooms.get(Number(id)) || null;
}

// Codigo curto e unico para salas privadas (so numeros, facil de falar/digitar)
function newRoomCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    let clash = false;
    for (const r of rooms.values()) {
      if (r.private && r.code === code) { clash = true; break; }
    }
    if (!clash) return code;
  }
  return String(Math.floor(1000 + Math.random() * 9000));
}

wss.on("connection", (ws) => {
  const client = {
    id: nextClientId++,
    ws,
    name: "CRIA",
    room: null,
    entId: 0,
    team: 0,
    lastSeq: 0,
    alive: true,
    send(type, data) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(encode(type, data)); } catch (e) { /* socket caindo */ }
      }
    }
  };
  clients.set(client.id, client);
  client.send(S2C.WELCOME, { id: client.id, modes: Object.keys(MODES) });

  ws.on("message", (raw) => {
    const msg = decode(raw.toString());
    if (!msg) return;

    switch (msg.t) {
      case C2S.HELLO: {
        const n = String(msg.d?.name || "").slice(0, 14).trim();
        if (n) client.name = n;
        break;
      }
      case C2S.QUEUE: {
        const mode = msg.d?.mode;
        if (!MODES[mode]) {
          client.send(S2C.ERROR, { message: "Modo invalido" });
          return;
        }
        if (client.room) client.room.removeClient(client);
        const room = findOrCreateRoom(mode);
        if (!room.addClient(client)) {
          client.send(S2C.ERROR, { message: "Sala cheia, tente de novo" });
          return;
        }
        client.send(S2C.QUEUED, {
          mode, players: room.playerCount, capacity: room.capacity
        });
        break;
      }
      case C2S.CREATE_ROOM: {
        const mode = msg.d?.mode;
        if (!MODES[mode]) {
          client.send(S2C.ERROR, { message: "Modo invalido" });
          return;
        }
        const privateRoom = !!msg.d?.private;
        const room = new Room(mode, {
          private: privateRoom,
          code: privateRoom ? newRoomCode() : "",
          onEmpty: (r) => rooms.delete(r.id)
        });
        rooms.set(room.id, room);
        if (client.room) client.room.removeClient(client);
        if (!room.addClient(client)) {
          rooms.delete(room.id);
          client.send(S2C.ERROR, { message: "Nao foi possivel entrar na sala" });
          return;
        }
        client.send(S2C.ROOM_CREATED, room.publicInfo());
        break;
      }
      case C2S.JOIN_ROOM: {
        const room = findRoomById(msg.d?.id);
        if (!room) {
          client.send(S2C.ERROR, { message: "Sala nao encontrada" });
          return;
        }
        if (room.private && String(msg.d?.code || "") !== room.code) {
          client.send(S2C.ERROR, { message: "Codigo incorreto" });
          return;
        }
        if (client.room) client.room.removeClient(client);
        if (!room.addClient(client)) {
          client.send(S2C.ERROR, { message: "Sala cheia" });
          return;
        }
        client.send(S2C.ROOM_JOINED, {
          ...room.publicInfo(),
          code: room.private ? room.code : undefined
        });
        break;
      }
      case C2S.GET_ROOMS: {
        const list = [];
        for (const r of rooms.values()) {
          if (!r.started && !r.private) list.push(r.publicInfo());
        }
        client.send(S2C.ROOM_LIST, { rooms: list });
        break;
      }
      case C2S.INPUT: {
        if (client.room) client.room.setInput(client, msg.d || {});
        break;
      }
      case C2S.LEAVE: {
        if (client.room) client.room.removeClient(client);
        break;
      }
      case C2S.PING: {
        client.send(S2C.PONG, { t: msg.d?.t });
        break;
      }
    }
  });

  ws.on("pong", () => { client.alive = true; });

  ws.on("close", () => {
    if (client.room) client.room.removeClient(client);
    clients.delete(client.id);
  });

  ws.on("error", () => {
    if (client.room) client.room.removeClient(client);
    clients.delete(client.id);
  });
});

// Mata conexoes zumbis (importante em hospedagem gratuita, que derruba sockets)
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch (e) { /* ignora */ }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`FUT DE CRIA — servidor multiplayer rodando na porta ${PORT}`);
  console.log(`Abra http://localhost:${PORT} para jogar.`);
});
