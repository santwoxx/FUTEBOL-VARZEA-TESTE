// Backend do CREATIVE FOOTBALL: API HTTP mínima + WebSocket das partidas.
//
// Este processo NÃO serve mais o jogo — o frontend estático vive na Vercel
// (pasta ../frontend). Aqui ficam apenas:
//   GET /health  → keep-alive / wake-up do plano free do Render
//   GET /rooms   → lista de salas abertas (fallback do lobby)
//   WebSocket    → salas autoritativas (30 ticks/s, 20 snapshots/s)

import http from "node:http";
import { WebSocketServer } from "ws";

import "./env.js";                 // le server/.env em dev (no-op em producao)

import { MODES } from "./shared/constants.js";
import { C2S, S2C, encode, decode } from "./shared/protocol.js";
import { Room } from "./room.js";
import { voiceConfig, voiceToken } from "./voice.js";

const PORT = process.env.PORT || 8080;

// Teto de snapshots represados por cliente antes de comecar a descartar.
// Um snapshot de 4v4 tem ~460 bytes, entao 8 KB e da ordem de 17 pacotes —
// quase um segundo de jogo parado na fila. Passou disso, a conexao nao esta
// dando conta e insistir so aumenta o atraso.
const SNAPSHOT_BACKLOG_MAX = 8 * 1024;

// Quantos snapshots foram descartados por congestionamento desde que o
// processo subiu. Aparece em /health: se esse numero sobe rapido, o problema
// e a rede dos jogadores (ou o plano do Render), nao a simulacao.
let snapshotsDropped = 0;

// Origens autorizadas a falar com este backend. Em produção, defina
// ALLOWED_ORIGINS no Render com os domínios da Vercel separados por vírgula:
//   https://creative-football.vercel.app,https://seu-dominio.com
// Sem a variável definida, libera geral (útil em dev e em preview deploys).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

function originAllowed(origin) {
  if (!ALLOWED_ORIGINS.length) return true;       // sem allowlist = liberado
  if (!origin) return true;                        // curl, apps nativos, health checks
  return ALLOWED_ORIGINS.includes(origin);
}

// Ecoa a origem em vez de "*": mantém a porta aberta para credenciais no futuro
// (o LiveKit token endpoint vai precisar) sem reescrever o CORS depois.
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": originAllowed(origin) ? (origin || "*") : "null",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

// ───────────────────────────────── API HTTP ─────────────────────────────────

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  } catch (e) {
    pathname = req.url;
  }

  // Wake-up do free tier: o frontend bate aqui assim que a página abre, então
  // o Render acorda enquanto o jogador ainda está no menu.
  //
  // "/" responde igual a "/health" de propósito: antes da separação a raiz
  // servia o jogo e devolvia 200, então o health check do Render pode estar
  // apontado para lá. Devolver 404 na raiz reprovaria todo deploy.
  if (pathname === "/health" || pathname === "/") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      service: "creative-football-backend",   // o jogo em si vive na Vercel
      rooms: rooms.size,
      players: clients.size,
      voice: voiceConfig().enabled,
      snapshotsDropped,
      uptime: Math.round(process.uptime())
    }));
    return;
  }

  if (pathname === "/rooms") {
    const list = [];
    for (const r of rooms.values()) {
      if (!r.started && !r.private) list.push(r.publicInfo());
    }
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(list));
    return;
  }

  res.writeHead(404, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found", hint: "backend só expõe /health, /rooms e o WebSocket" }));
});

// ──────────────────────────── WebSocket / salas ─────────────────────────────

// Agora que o frontend mora em outro dominio, o WebSocket deixa de ser
// same-origin: sem esta checagem qualquer site poderia abrir salas no seu
// servidor. Só vale quando ALLOWED_ORIGINS está definida.
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) => originAllowed(origin)
});
const rooms = new Map();      // roomId -> Room
const clients = new Map();    // clientId -> client
let nextClientId = 1;

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
    },
    // Snapshot ja vem serializado (a sala monta um texto so para todo mundo).
    //
    // Se o socket deste cliente ja esta entupido, enfileirar mais snapshot so
    // aumenta o atraso dele: o pacote que chegaria depois de 2s ja nasce
    // velho. Pular e esperar o proximo — que carrega o estado mais novo — faz
    // quem esta com a rede ruim voltar ao presente em vez de assistir ao
    // passado em camera lenta.
    sendRaw(text) {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > SNAPSHOT_BACKLOG_MAX) { snapshotsDropped++; return; }
      try { ws.send(text); } catch (e) { /* socket caindo */ }
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
        if (msg.d?.customConfig) client.customConfig = msg.d.customConfig;
        client.uid = msg.d?.uid || null;
        client.mpGoals = typeof msg.d?.mpGoals === "number" ? msg.d.mpGoals : 0;
        client.cardTier = typeof msg.d?.cardTier === "string" ? msg.d.cardTier : "silver";
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
      case C2S.QUEUE: {
        const mode = msg.d?.mode;
        if (!MODES[mode]) {
          client.send(S2C.ERROR, { message: "Modo invalido" });
          return;
        }
        if (client.room) client.room.removeClient(client);
        // Fila: entra na Sala publica deste modo (auto-matchmaking)
        const room = findOpenOrCreate(mode);
        if (!room.addClient(client)) {
          client.send(S2C.ERROR, { message: "Sala cheia, tente de novo" });
          return;
        }
        client.send(S2C.QUEUED, {
          mode, players: room.playerCount, capacity: room.capacity
        });
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
      case C2S.VOICE_TOKEN: {
        // Sala e time saem do estado do servidor, NUNCA do que o cliente pediu:
        // e isso que impede alguem de forjar um token para a voz de outra
        // partida (ou do time adversario) so mexendo no JSON.
        if (!client.room || !client.entId) {
          client.send(S2C.VOICE_TOKEN, { error: "not_in_room" });
          return;
        }
        // No 1v1 cada jogador fica num time, entao voz de time nao tem com quem
        // falar. Melhor nao mostrar HUD nenhum do que mostrar "aperte T" para
        // quem esta sozinho no time.
        if (client.room.teamSize < 2) {
          client.send(S2C.VOICE_TOKEN, { error: "solo" });
          return;
        }
        // Assinar um JWT e barato, mas nao a ponto de aceitar spam do cliente.
        const now = Date.now();
        if (client.lastVoiceToken && now - client.lastVoiceToken < 3000) return;
        client.lastVoiceToken = now;

        voiceToken({
          roomId: client.room.id,
          team: client.team,
          entId: client.entId,
          name: client.name
        }).then((v) => {
          client.send(S2C.VOICE_TOKEN, v || { error: "voice_disabled" });
        }).catch((err) => {
          console.error("voice token:", err.message);
          client.send(S2C.VOICE_TOKEN, { error: "token_failed" });
        });
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

function findOpenOrCreate(mode) {
  for (const r of rooms.values()) {
    if (r.mode === mode && !r.isFull && !r.private) return r;
  }
  const room = new Room(mode, { onEmpty: (r) => rooms.delete(r.id) });
  rooms.set(room.id, room);
  return room;
}

// Mata conexoes zumbis (importante em hospedagem gratuita, que derruba sockets)
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch (e) { /* ignora */ }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`CREATIVE FOOTBALL — backend na porta ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}  ·  Health: http://localhost:${PORT}/health`);
  const v = voiceConfig();
  console.log(v.enabled
    ? `VoIP LiveKit ativo: ${v.url}`
    : `VoIP desligado (defina LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET)`);
  console.log(ALLOWED_ORIGINS.length
    ? `CORS restrito a: ${ALLOWED_ORIGINS.join(", ")}`
    : `CORS liberado (defina ALLOWED_ORIGINS em producao)`);
});
