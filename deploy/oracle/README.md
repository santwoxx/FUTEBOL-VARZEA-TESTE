# Backend na Oracle Always Free (São Paulo)

Por que sair da Render: ela não tem região na América do Sul. Medido da máquina
do desenvolvedor (RTT ICMP):

| Região | RTT |
|---|---|
| **São Paulo** | **32 ms** |
| Virginia (melhor da Render) | 109 ms |
| Ohio | 125 ms |
| Oregon (era o que estava no ar) | 173 ms |

São ~77 ms a menos que a melhor opção da Render, e mais do que qualquer
otimização de código consegue devolver. A Oracle Always Free ainda dá CPU
dedicada — o plano free da Render estrangula CPU, e era isso que fazia o laço de
tick atrasar e o servidor despejar snapshots em rajada.

---

## 1. Criar a VM

Oracle Cloud → **Compute → Instances → Create Instance**

| Campo | Valor |
|---|---|
| Region | **Brazil East (São Paulo)** |
| Shape | **VM.Standard.A1.Flex** (Ampere ARM) — 1 OCPU e 6 GB já sobram |
| Image | **Canonical Ubuntu 24.04** |
| SSH key | envie a sua chave pública |

> A cota Always Free do ARM é 4 OCPUs + 24 GB no total. Se der
> *"Out of host capacity"*, tente outro Availability Domain ou volte mais tarde
> — é comum na São Paulo. O shape x86 `VM.Standard.E2.1.Micro` também é Always
> Free e serve, com menos folga.

Anote o **IP público** da instância.

## 2. Um hostname (obrigatório)

O jogo é servido em HTTPS pela Vercel, e navegador em página HTTPS **recusa
WebSocket inseguro** (`ws://`). Sem certificado o online não conecta — e
certificado exige um nome, não um IP.

**Se você tem domínio:** crie um registro `A` apontando para o IP público
(ex.: `jogo.seudominio.com`).

**Se não tem:** use o [DuckDNS](https://www.duckdns.org) — grátis, e o Let's
Encrypt emite certificado para esses subdomínios normalmente. Crie
`seunome.duckdns.org` e aponte para o IP.

Confira antes de seguir: `ping seu.hostname` tem que responder o IP da VM.

## 3. Provisionar

```bash
ssh ubuntu@SEU_IP
git clone --depth=1 https://github.com/santwoxx/FUTEBOL-VARZEA-TESTE.git /tmp/cf
sudo bash /tmp/cf/deploy/oracle/setup.sh jogo.seudominio.com
```

O script instala Node 22, clona o repositório em `/opt/creative-football`, sobe
o serviço no systemd e configura o Caddy com TLS automático.

> Ele clona o **repositório inteiro**, não só `server/`. O `server/auth.js` lê
> `../firestore.rules` para saber quem pode jogar online — clonando só o backend,
> o servidor sobe com zero e-mails liberados e ninguém entra.

## 4. Abrir a porta no console (o passo que todo mundo esquece)

A Oracle tem **dois** firewalls. O script já cuidou do `iptables` da máquina,
mas falta o da nuvem:

**Networking → Virtual Cloud Networks → sua VCN → Security Lists → Default →
Add Ingress Rules**

| Source | Protocolo | Porta |
|---|---|---|
| `0.0.0.0/0` | TCP | 80 |
| `0.0.0.0/0` | TCP | 443 |

Sem isso o Caddy nem consegue emitir o certificado (o Let's Encrypt precisa
alcançar a porta 80).

## 5. Conferir

```bash
curl -s https://jogo.seudominio.com/health
```

Esperado: `betaClosed: true` e `betaList` citando `firestore.rules`. Se vier
`betaList: "NENHUMA lista encontrada"`, o clone foi parcial — refaça o passo 3.

## 6. Apontar o jogo para o novo servidor

Em [`frontend/config.js`](../../frontend/config.js), troque a constante `PROD`:

```js
const PROD = "https://jogo.seudominio.com";
```

Commit e push: a Vercel republica sozinha. O `config.js` é o **único** arquivo
que sabe o endereço do backend — não há URL espalhada pelo jogo.

Para o APK, o `mobile-app/www/config.js` tem a mesma constante (ele força
produção sempre). Depois de trocar, rode `npx cap sync android` e gere o APK.

---

## Depois: manter no ar

**Publicar uma versão nova:**

```bash
sudo bash /opt/creative-football/deploy/oracle/atualizar.sh
```

Ele recusa reiniciar se houver gente jogando (as salas vivem em memória, um
restart derruba as partidas). Use `--forcar` para ignorar.

**Ver o que está acontecendo:**

```bash
systemctl status creative-football
journalctl -u creative-football -f
curl -s http://127.0.0.1:8080/health
```

**Configuração** (CORS, LiveKit, lista da beta): `/etc/creative-football.env`,
seguido de `sudo systemctl restart creative-football`. Revise o
`ALLOWED_ORIGINS` antes de abrir ao público — vazio significa que qualquer site
pode abrir salas no seu servidor.

## Cuidados

- **A Oracle recupera instâncias Always Free ociosas.** O critério é ficar
  semanas com uso muito baixo. Um servidor de jogo com gente entrando não corre
  risco, mas uma VM parada meses pode ser recuperada.
- **Uma instância só.** As salas vivem em memória; duas máquinas seriam dois
  conjuntos de partidas separados, e jogadores da mesma sala cairiam em
  servidores diferentes.
- **Faça backup da chave SSH.** Sem ela não há como entrar na VM, e a Oracle não
  reseta senha de instância.
