#!/usr/bin/env bash
# Publica a versao mais recente do main no servidor. Rode com sudo na VM.
#
#   sudo bash /opt/creative-football/deploy/oracle/atualizar.sh
#
# As salas vivem em memoria, entao o restart derruba quem estiver jogando.
# Nao ha jeito de contornar isso sem persistir estado — atualize em horario
# vazio, ou confira /health antes (o campo "players" diz quantos estao dentro).
set -euo pipefail

DESTINO="/opt/creative-football"
USUARIO="cfootball"

[[ $EUID -eq 0 ]] || { echo "rode com sudo." >&2; exit 1; }

jogando="$(curl -s --max-time 3 http://127.0.0.1:8080/health | grep -o '"players":[0-9]*' | cut -d: -f2 || echo "?")"
if [[ "${1:-}" != "--forcar" && "$jogando" != "0" && "$jogando" != "?" ]]; then
  echo "ha $jogando jogador(es) em partida agora."
  echo "use: sudo bash atualizar.sh --forcar   (ou espere esvaziar)"
  exit 1
fi

echo "==> baixando main"
git -C "$DESTINO" fetch --depth=1 origin main -q
git -C "$DESTINO" reset --hard origin/main -q
( cd "$DESTINO/server" && npm install --omit=dev --no-audit --no-fund -s )
chown -R "$USUARIO:$USUARIO" "$DESTINO"

echo "==> reiniciando"
systemctl restart creative-football
sleep 2
systemctl is-active --quiet creative-football \
  && echo "ok: $(curl -s --max-time 3 http://127.0.0.1:8080/health)" \
  || { echo "FALHOU:"; journalctl -u creative-football -n 30 --no-pager; exit 1; }
