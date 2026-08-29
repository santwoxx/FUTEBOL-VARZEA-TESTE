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
| `server/auth.js` | Confere o login Google e a lista da beta fechada do multiplayer. |
| `firestore.rules` | Regras do Firestore **e** a lista de e-mails da beta. |
| `server/env.js` | Lê `server/.env` em dev. Em produção não faz nada. |
| `tools/` | Scripts de desenvolvimento local (não vão para produção). |

Perfil e customização do jogador são **client-side puro**: Firebase Auth +
Firestore falam direto do browser com o Google. O backend não tem banco — mas
ele confere o login por conta própria antes de deixar alguém entrar numa sala
(veja [Beta fechada](#beta-fechada-do-multiplayer)).

---

## Rodar na sua máquina

```bash
npm install     # instala as dependências do server/
npm run dev     # sobe backend (8080) + frontend (5173) juntos
```

Abra <http://localhost:5173>. Jogar exige login com o Google — inclusive local.

Para testar o multiplayer sozinho em duas abas, crie `server/.env` com
`MP_OPEN=1`: as duas abas usam a mesma conta Google, e sem isso a segunda
derruba a primeira (mesmo `uid` na sala).

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

### Depois do primeiro deploy — 4 passos obrigatórios

1. **Firebase.** Console do Firebase → *Authentication* → *Settings* →
   *Authorized domains* → adicione o domínio da Vercel. Sem isso o login com
   Google quebra com `auth/unauthorized-domain` (o jogo mostra um alerta
   explicando).
2. **`ALLOWED_ORIGINS` no Render** com o domínio final da Vercel.
3. **Publique o `firestore.rules`** com a lista de quem pode jogar online —
   Console do Firebase → *Firestore Database* → *Regras*. O backend lê a mesma
   lista do arquivo no boot; confira em `/health` que `betaClosed` é `true`.
4. **Credenciais do LiveKit no Render**, se quiser a voz in-game — veja
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

**A pegadinha das três juntas:** predição desenha você no *presente*,
interpolação desenha o resto no *passado*. Enquanto você conduz, a bola é
sua — e vinha do passado, 100ms atrás. Correndo a 11 m/s isso põe a bola 1,1m
atrás de onde deveria estar, contra os 0,88m que ela fica à frente do pé: a
bola aparecia **atrás do personagem**. A correção é prever a bola também
enquanto você conduz, com a mesma conta do `dribbleBall()` do servidor. Quando a
bola não é sua, a interpolação continua mandando — ela vem de outro jogador e
*tem* que ser desenhada no passado, senão treme.

Pela mesma razão, o `yaw` local passou a convergir para o do servidor a cada
snapshot: ele só era escrito na primeira reconciliação e depois divergia em
silêncio (o servidor gira o corpo em ações que o cliente não prediz, como o
chute virando para a mira). Agora que a bola é posicionada a partir desse
ângulo, divergir mandaria a bola para o lado errado.

**Animações das próprias ações.** O estado do jogador vem do fluxo interpolado,
~100ms atrás. Para os outros isso é o certo; para você significava a perna
armando depois do clique. Chute, passe, carrinho e salto passaram a ser
previstos localmente — o servidor segue sendo a autoridade sobre o que
aconteceu com a bola, mas a animação sai junto com o botão. Pulo x cabeceio usa
o mesmo critério dos dois lados (bola entre 1,15m e 3,4m a menos de 2,6m).

Duas armadilhas resolvidas aí: a previsão marca `lastState`, senão a confirmação
do servidor 100ms depois rearmaria o `act` e a animação tocaria duas vezes; e o
estado "parado" atrasado do servidor é ignorado por completo enquanto a ação
prevista roda, senão ele zerava o `act` e matava a animação no quadro seguinte.

**Duração das animações.** Cada animação calcula o progresso como
`1 - act/DURAÇÃO`, com a duração escrita à mão dentro do `animateHumanoid`. No
online quem arma o `act` é a tabela `MP_STATE_DUR` — e os dois números **têm que ser
iguais**, senão a animação começa no meio ou congela antes do fim. O passe
estava assim: tabela 0,22 contra divisor 0,28, então ele começava com 21% já
andados e a perna nunca armava. Há teste que percorre todas as animações e
falha se alguém mexer num número sem mexer no outro.

**Congelamento de saque.** O servidor segura todo mundo por 1,2s no saque e
depois de cada gol, e mandava isso no snapshot (campo `f`) — que o cliente
guardava em `mp.frozen` e nunca lia. Resultado: durante o congelamento o
cliente predizia a corrida, fugia ~0,7m e era puxado de volta pela
reconciliação **20 vezes por segundo**. Não era um teleporte; era tremida no
saque e depois de todo gol — o que num 1v1 é o tempo todo.

### Mecânica das partidas

**Carrinho limpo atordoa.** Se você acerta a bola primeiro e quem estava
conduzindo está a menos de 2,4m, ele leva um susto de **0,3s**: não cai, mas
perde o carregamento de chute e leva um empurrão no sentido do deslize. Como
`findOwner()` ignora quem está atordoado, ele não recupera a bola no mesmo tique —
é essa janela que paga o risco de se jogar no chão. Errar a bola e pegar o
jogador continua sendo **falta**: tombo de 1,6s e o infrator travado por 2s.

**Segurar o chute demais estraga o chute.** A carga chega ao máximo em ~0,83s.
Daí em diante existe uma folga de ~0,12s (o `safe`) e depois a bola começa a
subir: o pé passa por baixo dela. No limite, a componente vertical é **2,9x**
maior e a horizontal cai 28% — o chute vai por cima do gol. A punição é
**determinística**, não sorteada: dá pra aprender o ponto de soltar.

A barra de força mostra a carga inteira, com uma **marca branca** onde a força
cheia acaba; passou dali, a barra pisca em vermelho. O online também ganhou a
barra (antes não tinha nenhuma), com a carga predita localmente pela mesma
fórmula do servidor — sem isso, a punição seria adivinhação.

**A bola não sai: é gaiola.** Laterais e fundos já devolviam a bola; o que
faltava era **teto, a 14m**. Sem ele, um chute estragado sumia da partida por
vários segundos até a gravidade trazer de volta. Agora bate na rede de cima,
perde 45% da velocidade vertical e 14% da horizontal, e volta pro jogo. A
única forma de a bola passar da linha continua sendo entrando no gol.

> Os números vivem em dois lugares de propósito — `server/shared/constants.js`
> (autoritativo) e `frontend/index.html` (single-player) — porque o single-player
> não importa módulos do servidor. Se você mexer em um, mexa no outro: o
> README promete que os dois têm a mesma sensação de pé.

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
| `Clique Esquerdo` ou `Espaço` | chute (segure para carregar — **mas não demais**, veja [Mecânica das partidas](#mecânica-das-partidas)) |
| `Clique Direito` ou `E` | passe (segure para carregar a força) |
| `R` | desarme |
| `Q` | carrinho |
| `V` | drible |
| `C` | pulo / cabeceio |
| `Esc` | soltar o mouse |
| `B` | falar com o time (online) |

---

## Números de referência

Medidos nos testes locais:

- **Banda:** ~3,4 KB/s por jogador no 1v1, ~9,3 KB/s no 4v4 (snapshot de 463 B
  a 20/s). Com voz, some ~24 kbps por pessoa falando.
- **CPU do envio de snapshot:** 0,019% de um núcleo por sala 4v4 (era 0,14%).
- **Conversão de chutes:** ~23% viram gol (cantos ~39%, meio ~15%).

### O que foi otimizado

**Servidor — uma serialização por sala, não por jogador.** O estado é o mesmo
para todo mundo; só o `ack` (último input processado) muda por cliente. Num 4v4
eram 8 `JSON.stringify` idênticos do mundo inteiro, 20 vezes por segundo. Agora o
corpo é serializado uma vez e o `ack` entra por concatenação: **7,5x mais rápido**,
com saída byte a byte idêntica.

**Servidor — descarta snapshot de quem está afogado.** Se o socket de um cliente
acumula mais de 8 KB na fila (~17 pacotes, quase um segundo), o próximo snapshot
é pulado em vez de enfileirado. Insistir só faria ele assistir ao passado em
câmera lenta; pular deixa a conexão ruim voltar ao presente. `GET /health` expõe
`snapshotsDropped` — se sobe rápido, o gargalo é rede, não simulação.

**Cliente — interpolação sem alocar.** `mpInterpolate()` roda a cada frame e
criava um `Map`, um objeto de bola e um objeto por entidade toda vez: ~720
objetos por segundo de lixo para o coletor, exatamente o tipo de coisa que vira
engasgo na hora do gol. Agora os objetos são reusados entre frames e o par de
entidades é achado por índice (a ordem do snapshot é estável) em vez de uma busca
linear por entidade: **3,1x mais rápido, zero alocação**.

## Beta fechada do multiplayer

Enquanto o online está em teste, o jogo funciona assim:

- **Jogar exige login com o Google.** Partida rápida, treino e vestiário abrem
  para qualquer conta.
- **O multiplayer exige convite.** Só entra quem está na lista de e-mails.

### Onde mora a lista

Num lugar só: a função `betaEmails()` do [`firestore.rules`](firestore.rules).
Ela serve aos dois lados:

| Lado | O que faz com a lista |
|---|---|
| Navegador | Só quem está nela consegue ler `betaAccess/{uid}` (regra do Firestore). É o que faz o jogo abrir o lobby ou a tela de "beta fechada". |
| Servidor | `server/auth.js` lê o **mesmo arquivo** no boot e recusa criar/entrar em sala de quem não está nela. Esta é a trava real. |

**Convidar alguém:** põe o e-mail (minúsculo) no `firestore.rules`, dá push — o
Render reconstrói e o backend recarrega a lista — e publica as regras no console
do Firebase. Uma edição, os dois lados atualizados.

Duas variáveis de ambiente ajustam isso quando precisa:

| Variável | Para quê |
|---|---|
| `MP_ALLOWED_EMAILS` | Atalho: liberar alguém no painel do Render sem esperar deploy. Se preenchida, manda no lugar do arquivo. |
| `MP_OPEN=1` | Abre o online para qualquer um logado. É o que destrava **testar sozinho em duas abas** — duas abas são a mesma conta Google, e a sala derruba o uid duplicado. |

O boot do servidor diz de onde leu a lista, e `/health` devolve
`betaClosed` + `betaList` (a origem, nunca os e-mails).

### Por que o servidor confere o login sozinho

A checagem no navegador serve para explicar ao jogador por que o botão está
trancado — quem abre o DevTools passa por cima dela em 10 segundos, e o
endereço do WebSocket está no `config.js`, à vista de todos.

Então quem barra de fato é o backend: no `hello`, o cliente manda o **ID token**
do Firebase e o `server/auth.js` confere a assinatura contra as chaves públicas
do Google (`securetoken@system.gserviceaccount.com`), o emissor, o projeto, a
validade e o `email_verified` — depois compara o e-mail com a lista. Sem
`firebase-admin`: o backend continua rodando com uma dependência só (`ws`).

Recusa gera `error` com `code: "beta"` (logado, fora da lista) ou
`code: "login"` (sem token / token vencido), e o jogo abre a tela certa para
cada caso.

---

## Apoiar o jogo (LivePix)

O botão **APOIAR O JOGO** no menu abre um painel com:

- a **meta de arrecadação** ao vivo, num `<iframe>` do widget do LivePix (o
  widget é feito para OBS: texto branco em fundo transparente, por isso fica
  sobre o card escuro, não sobre placa clara);
- o **QR Code** de <https://livepix.gg/sofia1227bb>, gerado como SVG e embutido
  no HTML — aparece na hora, sem depender de widget de terceiro carregar;
- o link direto da página de doação.

O iframe da meta só recebe `src` quando alguém abre o painel: quem só quer
jogar não paga o custo de rede de um recurso de terceiro.

Trocar de conta ou de meta = trocar o `data-src` do `#donateGoal` e o link do
`#donateOpenPage` em [`frontend/index.html`](frontend/index.html). Se mudar o
endereço da página, o QR precisa ser gerado de novo (ele codifica a URL).

O widget de **alertas** do LivePix não entra aqui de propósito: ele toca som e
narra doação: é overlay de OBS, não conteúdo de página — cada jogador ouviria o
alerta da sua live.

---

## VoIP — voz do time

Voz entre jogadores do **mesmo time**, durante a partida, via
[LiveKit Cloud](https://livekit.io).

Dois modos, em *SISTEMA & CONTROLES*:

| Modo | Como funciona |
|---|---|
| **Apertar para falar** (padrão) | Só transmite enquanto você segura a tecla de voz (`B` por padrão, remapeável junto com o resto dos controles). |
| **Sempre aberto** | Microfone ligado o tempo todo; a tecla vira liga/desliga. |

O **botão 🎙️ no canto da partida** muta nos dois modos — é uma chave geral, então
no modo de apertar a tecla não abre nada enquanto ele estiver mudo. Com a mira
travada o mouse não clica em nada, por isso o botão mostra a tecla escrita nele:
solte o mouse com `Esc` para clicar, ou use a tecla direto no meio da jogada.

Trocar de aba corta a transmissão mesmo no modo aberto — ninguém quer continuar
transmitindo o quarto depois de um alt-tab. O modo não muda: volta a valer quando
a aba recebe foco. Modo e mudo ficam salvos no `localStorage`.
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
  aperto da tecla renegociaria a conexão no meio da jogada.
- **Um cálculo só decide se transmite** (`voiceShouldTransmit()`): modo, mudo, tecla
  e foco da aba entram na mesma conta. Duas fontes de verdade aqui dariam no pior
  bug possível — microfone aberto sem o jogador saber.
- **Preset de fala, não de música:** 24 kbps em vez dos 48 kbps que o LiveKit usa
  por padrão, com a redundância (RED) mantida, que é o que segura a conversa em 4G
  ruim de beira de campo. DTX ligado: silêncio não vira pacote.
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

Do lado da rede, o próximo ganho real não é micro-otimização: é trocar o JSON do
snapshot por binário. Os campos já são numéricos e arredondados a 2 casas — um
`ArrayBuffer` cortaria os 463 B para perto de 100 B, mas custa a legibilidade que
hoje deixa depurar a partida com o DevTools aberto.
