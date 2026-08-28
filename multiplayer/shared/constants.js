// Constantes compartilhadas entre servidor (Node) e cliente (browser).
// Os numeros de campo/bola sao os mesmos do jogo single-player (neon-kick.html)
// para que o multiplayer tenha exatamente a mesma sensacao de jogo.

export const CFG = {
  W: 46, H: 76,
  GOAL_W: 16, GOAL_H: 4.0, GOAL_D: 3.2,
  MATCH: 180,
  BALL_R: 0.28,
  TICK_HZ: 30,      // passos de simulacao por segundo no servidor
  SNAP_HZ: 20,      // snapshots enviados por segundo para cada cliente
  MAX_TEAM: 4
};

export const HW = CFG.W / 2;
export const HH = CFG.H / 2;
export const GHW = CFG.GOAL_W / 2;

// Modos suportados: numero de jogadores de linha por time (o goleiro e sempre bot)
export const MODES = {
  "1v1": 1,
  "2v2": 2,
  "3v3": 3,
  "4v4": 4
};

// Posicoes de saida de bola por tamanho de time (espelhadas para o time 1)
export const FORMATIONS = {
  1: [{ x: 0, z: 9 }],
  2: [{ x: -7, z: 9 }, { x: 7, z: 9 }],
  3: [{ x: -9, z: 12 }, { x: 0, z: 6 }, { x: 9, z: 12 }],
  4: [{ x: -11, z: 13 }, { x: -4, z: 7 }, { x: 4, z: 7 }, { x: 11, z: 13 }]
};

// Estados de animacao que o servidor envia para o cliente reproduzir
// (mesma variedade de dribles e habilidades do partida rapida)
export const STATE = {
  IDLE: 0,
  RUN: 1,
  SPRINT: 2,
  KICK_CHARGE: 3,
  SHOT_TECHNIQUE: 4,
  SHOT_POWER: 5,
  PASS: 6,
  TACKLE: 7,
  STEAL: 8,
  DRIBBLE_STEPOVER: 9,
  DRIBBLE_ELASTICO: 10,
  DRIBBLE_ROULETTE: 11,
  DRIBBLE_DRAGBACK: 12,
  DRIBBLE_RAINBOW: 13,
  DRIBBLE_CARRETILHA: 14,
  JUMP: 15,
  HEADER: 16,
  FALL: 17,
  DIVE_LEFT: 18,
  DIVE_RIGHT: 19,
  CATCH: 20,
  DANCE: 21
};

// Nome textual usado pelo sistema de animacao do cliente (ordem == indice STATE)
export const STATE_NAME = [
  "idle", "run", "sprint", "kick_charge", "shot_technique", "shot_power",
  "pass", "tackle", "steal", "dribble_stepover", "dribble_elastico",
  "dribble_roulette", "dribble_dragback", "dribble_rainbow", "dribble_carretilha",
  "jump", "header", "fall", "dive_left", "dive_right", "catch_center", "dance"
];
