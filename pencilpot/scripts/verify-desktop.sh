#!/usr/bin/env bash
# verify-desktop.sh — assert the desktop integration is registered correctly.
# Exits nonzero if any check fails.
#
# Hyprland quirk: xdg-mime query filetype falls back to `file` (libmagic) when
# XDG_CURRENT_DESKTOP is not a recognised DE (GNOME/KDE/LXDE/…).  libmagic uses
# content-sniffing only and cannot consult the freedesktop shared-MIME globs, so
# it reports application/json for JSON-content *.pencil files.  The canonical
# freedesktop MIME lookup (used by Nautilus, Dolphin, Thunar and every other file
# manager) goes through GIO, which correctly returns application/x-pencil.
# We therefore use `gio info` for the filetype assertion on this host.

set -uo pipefail
fails=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fails=$((fails+1)); }

# 1. pencilpot on PATH
command -v pencilpot >/dev/null \
  && ok "pencilpot on PATH ($(command -v pencilpot))" \
  || bad "pencilpot not on PATH"

# 2. *.pencil glob → application/x-pencil
#    Use gio info (GLib/freedesktop MIME DB) rather than xdg-mime query filetype,
#    because on Hyprland the latter falls back to `file` (libmagic) which
#    content-sniffs {} as application/json and ignores our glob.
#    gio info uses the same DB that file managers use, so this is authoritative.
tmpf=$(mktemp --tmpdir="$HOME" --suffix=.pencil)
echo '{}' > "$tmpf"

if command -v gio >/dev/null 2>&1; then
  got_mime=$(gio info "$tmpf" 2>/dev/null | grep 'standard::content-type' | awk '{print $2}')
  detection_method="gio info"
else
  # gio not available — try forcing GNOME path in xdg-mime so it uses gio
  got_mime=$(XDG_CURRENT_DESKTOP=GNOME xdg-mime query filetype "$tmpf" 2>/dev/null || true)
  detection_method="xdg-mime (GNOME path)"
fi

[ "$got_mime" = "application/x-pencil" ] \
  && ok "*.pencil → application/x-pencil (via $detection_method)" \
  || bad "*.pencil MIME (got: $got_mime via $detection_method)"
rm -f "$tmpf"

# 3. Default handler
got_handler=$(xdg-mime query default application/x-pencil 2>/dev/null || true)
[ "$got_handler" = "pencilpot.desktop" ] \
  && ok "default handler = pencilpot.desktop" \
  || bad "default handler (got: $got_handler)"

# 4. .desktop file installed
desktop="$HOME/.local/share/applications/pencilpot.desktop"
[ -f "$desktop" ] \
  && ok ".desktop installed ($desktop)" \
  || bad ".desktop not installed"

# 5. Exec= line points at the pencilpot bin
if [ -f "$desktop" ]; then
  exec_line=$(grep -m1 '^Exec=' "$desktop" | cut -d= -f2-)
  exec_bin=$(echo "$exec_line" | awk '{print $1}')
  pencilpot_bin=$(command -v pencilpot 2>/dev/null || true)
  real_exec=$(readlink -f "$exec_bin" 2>/dev/null || echo "$exec_bin")
  real_pencilpot=$(readlink -f "$pencilpot_bin" 2>/dev/null || echo "$pencilpot_bin")
  [ "$real_exec" = "$real_pencilpot" ] \
    && ok "Exec= points at pencilpot bin ($exec_bin)" \
    || bad "Exec= mismatch: $exec_bin → $real_exec (expected $real_pencilpot)"
fi

echo
[ "$fails" -eq 0 ] \
  && echo "PASS — desktop integration registered" \
  || { echo "FAIL — $fails check(s) failed"; exit 1; }
