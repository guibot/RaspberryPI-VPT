#!/bin/bash
# Cria/remove um tema de cursor totalmente transparente em ~/.local/share/icons/video-player-invisible.
#   invisible-cursor.sh install | remove
# Usado por ./kiosk: com este tema o ponteiro nunca aparece (nem antes de o Chromium abrir, nem entre reinícios).
THEME="$HOME/.local/share/icons/video-player-invisible"
case "$1" in
  install)
    mkdir -p "$THEME/cursors"
    printf '[Icon Theme]\nName=video-player-invisible\nComment=Cursor invisivel (gerido por ./kiosk)\n' > "$THEME/index.theme"
    # Ficheiro Xcursor de 1x1 píxel, totalmente transparente.
    python3 -I - "$THEME/cursors/left_ptr" <<'PY'
import struct, sys
chunk = struct.pack('<9I', 36, 0xfffd0002, 1, 1, 1, 1, 0, 0, 0) + struct.pack('<I', 0)
head = b'Xcur' + struct.pack('<3I', 16, 0x10000, 1) + struct.pack('<3I', 0xfffd0002, 1, 28)
open(sys.argv[1], 'wb').write(head + chunk)
PY
    for n in default arrow top_left_arrow text xterm ibeam pointer hand hand1 hand2 grab grabbing openhand closedhand crosshair cross \
             wait watch progress left_ptr_watch move all-scroll fleur not-allowed crossed_circle no-drop help question_arrow context-menu \
             copy alias cell vertical-text zoom-in zoom-out col-resize row-resize \
             n-resize s-resize e-resize w-resize ne-resize nw-resize se-resize sw-resize ew-resize ns-resize nesw-resize nwse-resize \
             sb_h_double_arrow sb_v_double_arrow size_hor size_ver size_bdiag size_fdiag; do
      ln -sf left_ptr "$THEME/cursors/$n"
    done ;;
  remove) rm -rf "$THEME" ;;
  *) echo "uso: $0 install|remove" >&2; exit 2 ;;
esac
