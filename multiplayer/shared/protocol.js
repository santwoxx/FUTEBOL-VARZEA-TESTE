// Protocolo de mensagens cliente <-> servidor.
// Tudo trafega como JSON: e mais simples de depurar e o volume de dados de um
// 4v4 (10 entidades a 20 snapshots/s) cabe folgado nesse formato.

export const C2S = {
  HELLO: "hello",         // cliente se apresenta (nome, aparencia)
  QUEUE: "queue",         // entrar na fila de um modo (1v1..4v4)
  LEAVE: "leave",         // sair da fila / da partida
  INPUT: "input",         // estado dos controles do jogador (enviado ~30x/s)
  PING: "ping",
  CREATE_ROOM: "create_room",  // criar uma sala com modo especifico (e opcional privada)
  JOIN_ROOM: "join_room",      // entrar numa sala por ID (e codigo, se privada)
  GET_ROOMS: "get_rooms"       // pedir a lista de salas abertas
};

export const S2C = {
  WELCOME: "welcome",     // id atribuido ao cliente
  QUEUED: "queued",       // entrou na fila, aguardando oponentes
  ROOM_CREATED: "room_created",  // sala criada (com id/codigo)
  ROOM_LIST: "room_list",        // lista de salas abertas
  ROOM_JOINED: "room_joined",    // entrou numa sala (aguardando encher)
  MATCH_START: "start",   // partida formada: elenco, times, seu id de jogador
  SNAPSHOT: "snap",       // estado autoritativo do mundo
  GOAL: "goal",           // gol marcado (para efeitos/replay no cliente)
  MATCH_END: "end",       // fim de partida com placar final
  PLAYER_LEFT: "left",    // alguem desconectou (virou bot)
  PONG: "pong",
  ERROR: "error"
};

export function encode(type, data) {
  return JSON.stringify({ t: type, d: data });
}

export function decode(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg.t !== "string") return null;
    return msg;
  } catch (e) {
    return null;
  }
}

// Estrutura de um pacote de input. O servidor detecta as bordas (press/release)
// comparando com o input anterior, entao perder um pacote nunca deixa uma acao
// "presa" ligada — o proximo pacote ja corrige o estado.
export function makeInput() {
  return {
    seq: 0,
    dx: 0, dz: 0,      // direcao de movimento no espaco do mundo (ja normalizada)
    sprint: false,
    shoot: false,      // segurado = carregando chute
    pass: false,       // segurado = carregando passe
    tackle: false,
    steal: false,
    dribble: false,
    jump: false,
    dance: false,
    aimx: 0, aimy: 1, aimz: 0   // ponto de mira no mundo (crosshair)
  };
}
