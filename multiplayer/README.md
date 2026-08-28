# CREATIVE FOOTBALL — Multiplayer (1v1 · 2v2 · 3v3 · 4v4)

Multiplayer online com **servidor autoritativo**: a física, as regras e o placar
são decididos no servidor. O navegador só manda comandos e desenha o resultado.
Isso impede trapaça (ninguém edita a própria velocidade ou teleporta) e mantém
todo mundo vendo exatamente a mesma partida.

O jogo single-player original (`../neon-kick.html`) **não foi alterado** e
continua funcionando de forma independente.

---

## Rodar na sua máquina

```bash
cd multiplayer
npm install
npm start
```

Abra <http://localhost:8080>. Para testar o multiplayer sozinho, abra o
endereço em **duas abas** (ou duas janelas anônimas) e escolha o mesmo modo nas
duas — cada aba vira um jogador.

Se a porta 8080 já estiver em uso na sua máquina, escolha outra:

```bash
PORT=8099 npm start          # Git Bash / Linux / macOS
$env:PORT=8099; npm start    # PowerShell
```

### Jogar com amigos pela sua rede local
Descubra seu IP local (`ipconfig` no Windows) e passe para eles algo como
`http://192.168.0.15:8080`. Funciona sem deploy nenhum, desde que estejam no
mesmo Wi-Fi.

---

## Publicar na internet (Render.com — plano gratuito)

O projeto já vem com `render.yaml`, então o Render se configura sozinho.

**1. Suba o projeto para o GitHub**

```bash
cd ..                      # raiz do projeto (a pasta joguinho)
git init
git add .
git commit -m "Jogo + servidor multiplayer"
```

Crie um repositório vazio no GitHub e siga as instruções que ele mostra para
enviar (`git remote add origin ...` e `git push -u origin main`).

**2. Crie o serviço no Render**

1. Entre em <https://render.com> e faça login com a conta do GitHub.
2. Clique em **New → Blueprint**.
3. Escolha o repositório que você acabou de subir.
4. O Render lê o `render.yaml` e já preenche tudo. Confirme em **Apply**.

Em poucos minutos você recebe uma URL pública tipo
`https://fut-de-cria-multiplayer.onrender.com` — é só mandar para os amigos.

> Se preferir configurar na mão em vez de usar o Blueprint, os valores são:
> **Runtime** Node · **Root Directory** `multiplayer` · **Build** `npm install`
> · **Start** `npm start` · **Health Check Path** `/health`

**Sobre o plano gratuito:** o serviço "dorme" após ~15 minutos sem ninguém
acessando, e a primeira visita depois disso demora uns 30-50 segundos para
acordar. Partidas em andamento não são afetadas. Se isso incomodar, o plano
pago mais barato do Render (US$ 7/mês) remove a hibernação.

### Alternativas de hospedagem
Qualquer serviço que rode Node e aceite WebSocket serve: **Railway**,
**Fly.io**, **Koyeb** ou uma VPS própria. O comando é sempre o mesmo
(`npm start`), e a porta vem da variável de ambiente `PORT`.

---

## Como funciona

```
navegador (cliente)                      servidor (Node)
─────────────────────                    ────────────────────────
captura teclado/mouse
  └─ manda comandos ────── 30x/s ──────►  aplica no jogador certo
                                          roda a física (30 ticks/s)
                                          decide posse, gols, faltas
prediz seu movimento                      controla os bots
na hora (sem esperar)                        │
                                             ▼
desenha o resultado ◄───── 20x/s ────────  manda o estado do mundo
  └─ corrige a predição
     quando o estado chega
```

**Arquivos principais**

| Arquivo | Papel |
|---|---|
| `shared/sim.js` | Física e regras. Roda no servidor (autoritativo) **e** no cliente (predição). Sem Three.js, sem DOM. |
| `shared/constants.js` | Dimensões do campo, modos, formações. |
| `shared/protocol.js` | Formato das mensagens. |
| `server/index.js` | Servidor HTTP + WebSocket. |
| `server/room.js` | Uma sala = uma partida. Matchmaking e loop de tick. |
| `public/renderer.js` | Cena 3D, humanoides e animações. |
| `public/net.js` | Predição, reconciliação e interpolação. |
| `public/client.js` | Entrada, câmera, HUD e laço principal. |

**Três técnicas de netcode fazem o jogo parecer instantâneo mesmo com ping:**

- **Predição local** — seu jogador se move na hora que você aperta a tecla, sem
  esperar a resposta do servidor.
- **Reconciliação** — quando o estado oficial chega, o cliente corrige sua
  posição e reaplica os comandos que o servidor ainda não processou. Correções
  pequenas são suavizadas para não haver "teleporte".
- **Interpolação** — os outros jogadores e a bola são desenhados ~100ms no
  passado, entre dois estados recebidos, o que elimina tremida.

---

## Preenchimento com bots

As vagas vazias viram bots, então dá para jogar 4v4 mesmo com dois amigos só.
A partida começa quando a sala enche, ou automaticamente 12 segundos depois do
primeiro jogador entrar. Se alguém cair no meio do jogo, um bot assume a vaga
e a partida continua.

---

## Controles

| Tecla | Ação |
|---|---|
| `WASD` | mover |
| `Mouse` | girar a câmera / mirar |
| `Shift` | pique |
| `Clique Esquerdo` ou `Espaço` | chute (segure para carregar a força) |
| `Clique Direito` ou `E` | passe (segure para carregar a força) |
| `R` | desarme |
| `Q` | carrinho |
| `V` | drible |
| `C` | pulo / cabeceio |
| `Esc` | soltar o mouse |

---

## Números de referência

Medidos nos testes locais:

- **Banda:** ~3,4 KB/s por jogador no 1v1, ~8,7 KB/s no 4v4.
- **CPU:** ~0,03% de um núcleo por partida — o gargalo do plano gratuito será
  memória e rede, não processamento.
- **Conversão de chutes:** ~23% viram gol (cantos ~39%, meio ~15%), então
  mirar bem é recompensado.

---

## Versão APK (Android)

Ainda não feita — o foco combinado foi PC primeiro. Quando for a hora, o
caminho mais direto é empacotar este mesmo cliente web com **Capacitor**
(`npm install @capacitor/core @capacitor/android`), apontando para a URL do
servidor publicado. Os controles de toque precisarão ser reativados: o jogo
single-player já tem um joystick virtual e botões contextuais que podem ser
portados de `../neon-kick.html`.
