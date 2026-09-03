#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# CREATIVE FOOTBALL — provisionamento do backend numa VM Oracle Always Free
#
# Roda uma vez, numa Ubuntu 22.04/24.04 recem-criada (ARM Ampere ou x86).
# Deixa no ar: Node 22 + o servidor de jogo como servico + Caddy fazendo TLS
# automatico (Let's Encrypt) e repassando o WebSocket.
#
#   sudo bash setup.sh SEU.DOMINIO.COM
#
# Por que precisa de dominio: o jogo e servido em HTTPS pela Vercel, e navegador
# em pagina HTTPS recusa WebSocket inseguro (ws://). Sem certificado, o online
# simplesmente nao conecta. Se voce nao tem dominio, o README explica o caminho
# gratuito com DuckDNS — o script aceita esse hostname igual.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DOMINIO="${1:-}"
REPO="${REPO:-https://github.com/santwoxx/FUTEBOL-VARZEA-TESTE.git}"
DESTINO="/opt/creative-football"
USUARIO="cfootball"

if [[ -z "$DOMINIO" ]]; then
  echo "uso: sudo bash setup.sh SEU.DOMINIO.COM" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "rode com sudo." >&2
  exit 1
fi

echo "==> 1/7  pacotes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw netfilter-persistent iptables-persistent

echo "==> 2/7  Node 22 (o server/package.json pede engines node 22.x)"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  ARCH="$(dpkg --print-architecture)"
  echo "deb [arch=$ARCH signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v)"

echo "==> 3/7  usuario de servico e codigo"
id -u "$USUARIO" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USUARIO"

# Clona o REPOSITORIO INTEIRO, e nao so a pasta server/: o auth.js le
# ../firestore.rules (a lista da beta) a partir da raiz. Clonar so o backend
# faz o servidor subir com 0 e-mails liberados e ninguem entra no online.
if [[ -d "$DESTINO/.git" ]]; then
  git -C "$DESTINO" fetch --depth=1 origin main -q
  git -C "$DESTINO" reset --hard origin/main -q
else
  rm -rf "$DESTINO"
  git clone --depth=1 "$REPO" "$DESTINO" -q
fi
( cd "$DESTINO/server" && npm install --omit=dev --no-audit --no-fund -s )
chown -R "$USUARIO:$USUARIO" "$DESTINO"

echo "==> 4/7  variaveis de ambiente"
if [[ ! -f /etc/creative-football.env ]]; then
  cat > /etc/creative-football.env <<EOF
# Porta interna; quem fala com a internet e o Caddy.
PORT=8080

# Trava o CORS e o WebSocket nos dominios do frontend. SEM ISTO qualquer site
# abre salas no seu servidor. Separe varios por virgula.
ALLOWED_ORIGINS=https://futebol-varzea-teste.vercel.app

# Projeto que assina os ID tokens do login Google.
FIREBASE_PROJECT_ID=creative-footbal

# Voz do time (LiveKit). Deixe vazio para desligar o VoIP.
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

# Atalho para liberar alguem no online sem editar o firestore.rules.
# MP_ALLOWED_EMAILS=

# MP_OPEN=1 abre o online para qualquer conta Google valida (so para teste).
EOF
  chmod 600 /etc/creative-football.env
  echo "    criado /etc/creative-football.env  (revise antes de abrir ao publico)"
else
  echo "    /etc/creative-football.env ja existe, mantido"
fi

echo "==> 5/7  servico systemd"
cat > /etc/systemd/system/creative-football.service <<EOF
[Unit]
Description=CREATIVE FOOTBALL - servidor de partidas
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USUARIO
WorkingDirectory=$DESTINO/server
EnvironmentFile=/etc/creative-football.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
# As salas vivem em memoria: uma queda derruba as partidas em andamento, entao
# reiniciar rapido importa mais do que reiniciar "limpo".
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now creative-football

echo "==> 6/7  Caddy (TLS automatico + WebSocket)"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
cat > /etc/caddy/Caddyfile <<EOF
$DOMINIO {
	encode zstd gzip
	# reverse_proxy do Caddy ja repassa Upgrade/Connection: o WebSocket do jogo
	# passa por aqui sem configuracao extra.
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
EOF
systemctl restart caddy

echo "==> 7/7  firewall"
# Oracle tem DOIS firewalls e essa e a pegadinha classica: liberar a porta na
# Security List do console NAO basta, porque a imagem Ubuntu da Oracle ja vem
# com iptables restritivo. Precisa dos dois lados.
iptables -C INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -p tcp --dport 80  -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
netfilter-persistent save >/dev/null 2>&1 || true

echo
echo "════════════════════════════════════════════════════════════"
systemctl is-active --quiet creative-football \
  && echo "servico:  ATIVO" || echo "servico:  FALHOU  ->  journalctl -u creative-football -n 40"
echo "teste:    curl -s https://$DOMINIO/health"
echo
echo "FALTA FAZER NO CONSOLE DA ORACLE:"
echo "  Networking > VCN > Security List > Ingress: liberar TCP 80 e 443 de 0.0.0.0/0"
echo
echo "E NO FRONTEND: aponte a constante PROD de frontend/config.js para"
echo "  https://$DOMINIO"
echo "════════════════════════════════════════════════════════════"
