# CREATIVE FOOTBALL

Jogo de futebol de várzea 3D com multiplayer online (1v1 · 2v2 · 3v3 · 4v4) e
**servidor autoritativo**: a física, as regras e o placar são decididos no
servidor. O navegador só manda comandos e desenha o resultado.

## Arquitetura

O projeto é dividido em dois deploys independentes:

```
frontend/  ──►  Vercel (CDN estático)      o jogo inteiro: index.html + config.js
server/    ──►  Render (Node + WebSocket)  salas autoritativas, 30 ticks/s
```

Por que separado:

- **Deploy da UI não derruba partida.** As salas vivem em memória. Quando tudo
  rodava num processo só, mudar um botão reiniciava o servidor e expulsava
  todo mundo que estava jogando.
- **Cold start deixa de ser tela branca.** O plano free do Render hiberna após
  ~15min. Com o HTML no CDN, a página abre na hora e o frontend dispara um
  `GET /health` no load — o backend acorda enquanto o jogador ainda está no
  menu.
- **Latência de download.** O bundle sai do edge, não de Oregon.

O que a separação **não** resolve: o ping do jogo, que continua sendo do
browser até o Render. Para isso o que importa é a região (`region:` no
`render.yaml` — Virginia/Ohio fica ~120ms do Brasil contra ~180ms de Oregon) e
sair do plano free.

| Pasta | Papel |
|---|---|
| `frontend/index.html` | O jogo inteiro: Three.js, cena, HUD, lobby, netcode do cliente. |
| `frontend/config.js` | **Único** arquivo que sabe o endereço do backend. |
| `frontend/vercel.json` | Config de deploy da Vercel. |
| `server/server.js` | API HTTP (`/health`, `/rooms`) + WebSocket. |
| `server/room.js` | Uma sala = uma partida. Matchmaking e loop de tick. |
| `server/shared/sim.js` | Física e regras (autoritativo no servidor). |
| `server/shared/constants.js` | Dimensões do campo, modos, formações. |
| `server/shared/protocol.js` | Formato das mensagens. |
| `server/voice.js` | Assina os tokens da voz do time (LiveKit). |
| `server/env.js` | Lê `server/.env` em dev. Em produção não faz nada. |
| `tools/` | Scripts de desenvolvimento local (não vão para produção). |

Autenticação e perfil do jogador são **client-side puro**: Firebase Auth +
Firestore falam direto do browser com o Google. O backend não tem banco.

---

## Rodar na sua máquina

```bash
npm install     # instala as dependências do server/
npm run dev     # sobe backend (8080) + frontend (5173) juntos
```

Abra <http://localhost:5173>. Para testar o multiplayer sozinho, abra em duas
abas e escolha o mesmo modo nas duas.

Em `localhost` o `config.js` aponta sozinho para `http://localhost:8080` — você
não precisa configurar nada. Para jogar com amigos no mesmo Wi-Fi, passe o seu
IP local (`ipconfig`) na porta 5173: `http://192.168.0.15:5173`, que o config
resolve o backend no mesmo IP.

Rodar um de cada vez, se preferir:

```bash
npm run dev:server     # só o backend
npm run dev:web        # só o frontend
```

Para apontar o frontend local contra o backend de produção:
<http://localhost:5173/?server=https://futebol-varzea-teste.onrender.com>

---

## Deploy

### Backend — Render

O `render.yaml` na raiz já configura tudo. **Render → New → Blueprint →**
aponte para este repositório.

Se o serviço já existe (é o caso), só garanta no dashboard:

| Campo | Valor |
|---|---|
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

E adicione a variável de ambiente:

```
ALLOWED_ORIGINS = https://<seu-projeto>.vercel.app
```

Isso trava o CORS e o WebSocket nos domínios do frontend. **Sem ela, o backend
aceita conexão de qualquer site.** Aceita vários domínios separados por
vírgula — inclua os previews da Vercel se for testar por lá.

### Frontend — Vercel

**Vercel → Add New → Project →** importe o repositório e mude **uma** opção:

| Campo | Valor |
|---|---|
| Root Directory | `frontend` |
| Framework Preset | Other |
| Build Command | *(vazio)* |
| Output Directory | *(vazio)* |

Não há build: é HTML estático.

### Depois do primeiro deploy — 3 passos obrigatórios

1. **Firebase.** Console do Firebase → *Authentication* → *Settings* →
   *Authorized domains* → adicione o domínio da Vercel. Sem isso o login com
   Google quebra com `auth/unauthorized-domain` (o jogo mostra um alerta
   explicando).
2. **`ALLOWED_ORIGINS` no Render** com o domínio final da Vercel.
3. **Credenciais do LiveKit no Render**, se quiser a voz in-game — veja
   [VoIP](#voip--voz-do-time) abaixo. Sem elas o jogo funciona igual, só sem voz.

Se o backend mudar de endereço, o único lugar a editar é a constante `PROD` em
[`frontend/config.js`](frontend/config.js).

---

## Como funciona

```
navegador (Vercel)                       servidor (Render)
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

**Três técnicas de netcode fazem o jogo parecer instantâneo mesmo com ping:**

- **Predição local** — seu jogador se move na hora que você aperta a tecla, sem
  esperar a resposta do servidor.
- **Reconciliação** — quando o estado oficial chega, o cliente corrige sua
  posição e reaplica os comandos que o servidor ainda não processou. Correções
  pequenas são suavizadas para não haver "teleporte".
- **Interpolação** — os outros jogadores e a bola são desenhados ~100ms no
  passado, entre dois estados recebidos, o que elimina tremida.

### Preenchimento com bots

As vagas vazias viram bots, então dá para jogar 4v4 mesmo com dois amigos só. A
partida começa quando a sala enche, ou automaticamente 12 segundos depois do
primeiro jogador entrar. Se alguém cair no meio do jogo, um bot assume a vaga e
a partida continua.

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
- **CPU:** ~0,03% de um núcleo por partida.
- **Conversão de chutes:** ~23% viram gol (cantos ~39%, meio ~15%).

## VoIP — voz do time

Voz entre jogadores do **mesmo time**, durante a partida, via
[LiveKit Cloud](https://livekit.io).

- **`T`** — segure para falar (push-to-talk).
- **`M`** — trava o microfone aberto. Aperte de novo para destravar.
- Trocar de aba corta a transmissão, mesmo com o mic travado.
- **Só a partir do 2v2.** No 1v1 os dois jogadores caem em times opostos, então
  não existe companheiro para ouvir e o HUD de voz nem aparece.

> **Para testar:** o servidor equilibra os times na ordem de entrada — 1º e 3º a
> entrar ficam no time 0, 2º e 4º no time 1. Com duas abas você sempre cai em
> times opostos e não se escuta. Abra **quatro** abas num 2v2 (ou três, e espere
> os 12s do preenchimento com bots) e fale entre a 1ª e a 3ª.

### Por que o token sai do servidor de jogo

O `server/` é o único lugar que sabe em qual sala e em qual time você está.
Ele assina um JWT com a sala de voz já escrita dentro
(`cf-<sala>-t<time>`) — sala e time saem do estado do WebSocket, **nunca** do
que o cliente pediu. Como o LiveKit isola salas entre si, não existe cliente
modificado que escute o time adversário.

A mídia não passa pelo Render: quem carrega o áudio é o SFU do LiveKit. O
backend só emite credencial.

### Configurar

No [LiveKit Cloud](https://cloud.livekit.io): *Settings → Keys → Create Key*.
Depois, no Render (*Environment*) — ou em `server/.env` para rodar local,
copiando de [`server/.env.example`](server/.env.example):

```
LIVEKIT_URL=wss://<projeto>.livekit.cloud
LIVEKIT_API_KEY=API...
LIVEKIT_API_SECRET=<segredo>
```

Sem as três variáveis o VoIP fica desligado e o resto do jogo continua
idêntico — nenhum erro na tela, o HUD de voz simplesmente não aparece.
Para conferir se chegaram, `GET /health` responde `"voice": true`.

O `API_SECRET` nunca vai para o repositório: no `render.yaml` as três estão
como `sync: false` (o valor vive só no painel) e `server/.env` está no
`.gitignore`.

### Detalhes de implementação

- **Permissão do microfone é pedida no lobby**, não na partida. Durante o jogo
  o mouse está travado (pointer lock) e a caixa de permissão do navegador
  arrancaria o jogador do controle bem na hora em que ele quis falar.
- **O SDK (~1,3 MB) só baixa quando a primeira partida começa.** Quem nunca
  joga online não paga esse download.
- **O microfone é publicado uma vez e depois só muta/desmuta.** Publicar a cada
  aperto do `T` renegociaria a conexão no meio da jogada.
- Você entra na partida ouvindo o time, mas **mudo**.

### Custo

Voz consome minutos de participante no plano free do LiveKit. Um 4v4 de 3
minutos gasta ~24 minutos de participante (8 jogadores × 3 min). Acompanhe em
*Billing* no painel.

---

## Próximo passo

Voz espacial: ouvir mais alto quem está perto de você no campo. O LiveKit
entrega as faixas separadas por participante, então dá para ligar cada uma a um
`PannerNode` do Web Audio usando a posição que o snapshot já traz.
