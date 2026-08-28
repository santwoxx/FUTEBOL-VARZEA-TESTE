// VoIP das partidas: assina os tokens que o cliente usa para entrar na sala de
// voz do LiveKit Cloud.
//
// A midia NAO passa por aqui. O Render so diz *quem pode falar com quem* — quem
// carrega o audio e o SFU do LiveKit, que e justamente o motivo de este endpoint
// morar no servidor de jogo: e ele que sabe em qual sala e em qual time voce esta.
//
// Configuracao (Render > Environment, ou server/.env em dev):
//   LIVEKIT_URL         wss://<projeto>.livekit.cloud
//   LIVEKIT_API_KEY     API...
//   LIVEKIT_API_SECRET  (segredo — nunca versionar)
//
// Sem as tres variaveis, o VoIP fica desligado e o resto do jogo continua igual.

import { AccessToken } from "livekit-server-sdk";

// Lido a cada chamada (e nao no import) para nao depender da ordem em que os
// modulos carregam nem de o .env ja ter sido lido.
export function voiceConfig() {
  const url = (process.env.LIVEKIT_URL || "").trim();
  const key = (process.env.LIVEKIT_API_KEY || "").trim();
  const secret = (process.env.LIVEKIT_API_SECRET || "").trim();
  return { url, key, secret, enabled: !!(url && key && secret) };
}

// Uma sala de voz por TIME. O LiveKit isola salas entre si, entao a separacao
// aqui e o que garante que o adversario nao escuta a conversa: nao da para
// furar pelo cliente, porque o token so vale para a sala escrita dentro dele.
export function voiceRoomName(roomId, team) {
  return `cf-${roomId}-t${team}`;
}

// Cobre varias partidas seguidas na mesma sala (o servidor reinicia a partida
// depois de 8s), sem virar um token eterno se alguem copiar o JWT.
const TTL = "2h";

export async function voiceToken({ roomId, team, entId, name }) {
  const cfg = voiceConfig();
  if (!cfg.enabled) return null;

  const room = voiceRoomName(roomId, team);
  const identity = `p${entId}`;      // unico dentro da partida

  const at = new AccessToken(cfg.key, cfg.secret, {
    identity,
    name: name || "CRIA",
    ttl: TTL
  });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false            // o jogo ja tem o proprio canal de dados
  });

  return { url: cfg.url, room, identity, token: await at.toJwt() };
}
