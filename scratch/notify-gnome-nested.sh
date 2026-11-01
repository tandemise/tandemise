#!/bin/sh
# Runs a command against a private, headless GNOME Shell: its own session bus
# (dbus-run-session), a virtual 1280x800 monitor, GSettings in a keyfile under
# $NOTIFY_NESTED_DIR and XDG dirs there too. Nothing of the person's desktop
# is read or written: not their dconf (so their Do Not Disturb stays as it is),
# not ~/.local/share/applications.
#
#   NOTIFY_NESTED_DIR=/tmp/x sh scratch/notify-gnome-nested.sh node scratch/notify-gnome-check.mjs
#
# Needs gnome-shell (it is the same build as the desktop's), dbus-run-session,
# gdbus and python3 with gi (for scratch/notify-gnome-shell.py).
set -e
dir="${NOTIFY_NESTED_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/tdm-gnome-XXXXXX")}"
mkdir -p "$dir"
if [ -z "$NOTIFY_NESTED_INSIDE" ]; then
  NOTIFY_NESTED_INSIDE=1 NOTIFY_NESTED_DIR="$dir" exec dbus-run-session -- sh "$0" "$@"
fi

export GSETTINGS_BACKEND=keyfile
export XDG_CONFIG_HOME="$dir/config" XDG_DATA_HOME="$dir/data" XDG_CACHE_HOME="$dir/cache" XDG_STATE_HOME="$dir/state"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
export WAYLAND_DISPLAY="tandemise-nested-$$"
unset DISPLAY
gnome-shell --headless --wayland --no-x11 --wayland-display "$WAYLAND_DISPLAY" --virtual-monitor 1280x800 > "$dir/gnome-shell.log" 2>&1 &
shell=$!
i=0
until gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell > /dev/null 2>&1; do
  i=$((i + 1))
  if [ $i -gt 60 ]; then echo "GNOME Shell did not start; see $dir/gnome-shell.log" >&2; kill $shell; exit 1; fi
  sleep 0.5
done
# Let the Shell finish starting up (the notification daemon is activated on first use).
sleep 2
set +e
"$@"
status=$?
kill $shell 2>/dev/null
wait $shell 2>/dev/null
exit $status
