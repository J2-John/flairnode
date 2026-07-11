#!/usr/bin/env bash

# Flair Kiosk start script!
#
# Autostart approach: XDG autostart (~/.config/autostart/*.desktop).
# The first time this script runs, it installs itself as an XDG autostart
# entry for the current user. XDG autostart is honored by every mainstream
# Linux desktop environment (GNOME, XFCE, LXDE, MATE, KDE, ...) once that
# user's desktop session finishes loading, so this works without knowing or
# hardcoding which DE ships on a given unit. It assumes the device already
# boots straight into an autologged-in desktop session (a separate, per-unit
# OS setup concern, not handled by this script). On a power cycle: desktop
# session starts -> DE reads ~/.config/autostart -> this script runs again ->
# the autostart entry already exists so installing it is a no-op -> Chromium
# launches. Net effect: a power-cycled unit comes back playing with zero
# human touch, after the one-time manual run that installs the entry.

AUTOSTART_DIR="$HOME/.config/autostart"
AUTOSTART_FILE="$AUTOSTART_DIR/flairnode-kiosk.desktop"
SCRIPT_PATH="$HOME/flairnode/flairnode-kiosk.sh"

if [ ! -f "$AUTOSTART_FILE" ]; then
        echo "Installing kiosk autostart entry at $AUTOSTART_FILE..."
        mkdir -p "$AUTOSTART_DIR"
        cat > "$AUTOSTART_FILE" <<AUTOSTART
[Desktop Entry]
Type=Application
Name=Flair Node Kiosk
Exec=$SCRIPT_PATH
X-GNOME-Autostart-enabled=true
Hidden=false
AUTOSTART
fi

echo "Starting Chromium test kiosk..."
sleep 3;

chromium \
        --kiosk "file://$HOME/flairnode/render.html" \
        --noerrdialogs \
        --disable-infobars \
        --disable-session-crashed-bubble \
        --no-first-run \
        --disable-features=PointerLock \
        --disable-translate \
        --disable-component-update \
        --disable-background-networking \
        --disable-sync \
        --metrics-recording-only \
        --no-service-autorun \
        --autoplay-policy=no-user-gesture-required \
        --password-store=basic \
        --user-data-dir="$HOME/.flair-chrome-test"
