// Constantes compartilhadas entre servidor (Node) e cliente (browser).
// Os numeros de campo/bola sao os mesmos do jogo single-player (frontend/index.html)
// para que o multiplayer tenha exatamente a mesma sensacao de jogo.

export const CFG = {
  W: 46, H: 76,
  // Teto da gaiola. As laterais e os fundos ja devolviam a bola; sem um teto,
  // um chute furado sumia da partida por varios segundos ate a gravidade
  // trazer de volta. 14m fica bem acima de qualquer chute normal (o mais alto
  // com carga cheia sobe ~3m), entao so a bola escangalhada bate la em cima.
  CEIL: 14,
  GOAL_W: 16, GOAL_H: 4.0, GOAL_D: 3.2,
  MATCH: 180,
  BALL_R: 0.28,
  TICK_HZ: 30,      // passos de simulacao por segundo no servidor
  // Um snapshot por tick. A 20 Hz o cliente media 50ms de espacamento e, para
  // nao esvaziar o buffer no primeiro engasgo da rede, segurava ~110ms de
  // atraso de interpolacao — atraso que o jogador sente como "o adversario
  // aparece depois". A 30 Hz o espacamento cai para 33ms e o mesmo buffer de
  // seguranca custa ~75ms: 35ms a menos de atraso, de graca.
  //
  // O custo e banda: um snapshot de 4v4 tem ~460 bytes, entao sao ~14 KB/s por
  // jogador em vez de 9 KB/s. Nada perto do que qualquer conexao aguenta, e a
  // serializacao continua sendo UMA por sala (o texto e o mesmo para todos).
  SNAP_HZ: 30,      // snapshots enviados por segundo para cada cliente
  MAX_TEAM: 4
};

// Carga do chute. Segurar ate 1.0 e forca; passar disso e o pe entrando por
// baixo da bola — ela sobe e perde direcao. E o risco que paga encher o pe.
export const KICK = {
  rate:      1.2,   // carga por segundo
  safe:      1.15,  // folga (~0,12s) depois da forca cheia antes de comecar a furar
  max:       1.6,   // teto da carga: ~0,37s de risco depois da folga
  overLoft:  1.9,   // multiplicador maximo na componente vertical
  overPower: 0.28   // fracao da forca horizontal perdida no chute furado
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
  DANCE: 21,
  // Acoes exclusivas do goleiro humano. Acrescentadas NO FIM de proposito: os
  // indices anteriores viajam nos snapshots e nao podem mudar de significado.
  DIVE_HIGH: 22,   // defesa no alto, saltando reto
  PUNCH: 23,       // espalmada de soco: tira a bola da area
  THROW: 24        // reposicao com a mao
};

// Nome textual usado pelo sistema de animacao do cliente (ordem == indice STATE)
export const STATE_NAME = [
  "idle", "run", "sprint", "kick_charge", "shot_technique", "shot_power",
  "pass", "tackle", "steal", "dribble_stepover", "dribble_elastico",
  "dribble_roulette", "dribble_dragback", "dribble_rainbow", "dribble_carretilha",
  "jump", "header", "fall", "dive_left", "dive_right", "catch_center", "dance",
  "dive_high", "punch", "throw"
];
