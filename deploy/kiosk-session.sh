#!/bin/bash
# Sessão kiosk: espera pelo servidor e mantém o Chromium aberto em ecrã inteiro.
# É lançado pelo ~/.config/labwc/autostart (criado por ./kiosk on). Termina com o labwc.
URL="${PLAYER_URL:-http://localhost:8080/player/}"
PROFILE="${PLAYER_PROFILE:-$HOME/.config/video-player-chromium}"   # perfil próprio, separado do Chromium normal

# Espera até 2 min pelo servidor (arranca em paralelo, como serviço).
for _ in $(seq 1 120); do curl -fs -o /dev/null "${URL%/player/}/api/info" && break; sleep 1; done

LABWC_PID=$(pidof labwc)
while [ "$(pidof labwc)" = "$LABWC_PID" ]; do
  # Evita o aviso "o Chromium não fechou corretamente" depois de uma falha ou corte de energia.
  if [ -f "$PROFILE/Default/Preferences" ]; then
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$PROFILE/Default/Preferences"
  fi
  chromium --user-data-dir="$PROFILE" --ozone-platform=wayland \
    --kiosk --start-fullscreen --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
    --disable-features=Translate,TranslateUI --lang=pt-PT --no-first-run --no-default-browser-check --password-store=basic \
    --autoplay-policy=no-user-gesture-required --overscroll-history-navigation=0 --disable-pinch \
    "$URL"
  sleep 2     # se o Chromium falhar ou fechar, volta a abrir
done
