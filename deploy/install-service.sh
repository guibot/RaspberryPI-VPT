#!/bin/bash
# Instala e ativa o serviço systemd do servidor (precisa de sudo). Uso: deploy/install-service.sh [remove]
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT=/etc/systemd/system/video-server.service
if [ "$1" = remove ]; then
  sudo systemctl disable --now video-server.service || true
  sudo rm -f "$UNIT"; sudo systemctl daemon-reload; echo "serviço removido"; exit 0
fi
sed -e "s|@USER@|$USER|" -e "s|@ROOT@|$ROOT|" "$ROOT/deploy/video-server.service.in" | sudo tee "$UNIT" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now video-server.service
systemctl --no-pager --lines=0 status video-server.service
