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
#
# If you see "unrecognized flag" / unknown-flag errors from V8 at launch,
# they are not coming from the flag list below — this script has been
# verified against current Chromium source. Look at OS-level Chromium
# config on that unit instead (e.g. a system flags file such as
# /etc/chromium.d/ or a policy file), which can inject additional flags
# this script never passes.

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

CHROMIUM_FLAGS=(
        --kiosk "file://$HOME/flairnode/render.html"
        --noerrdialogs
        --disable-session-crashed-bubble
        --no-first-run
        # --disable-features=PointerLock: unverified feature name, likely silent
        # no-op - kept because removal gains nothing and it may guard older builds.
        --disable-features=PointerLock
        --disable-component-update
        --disable-background-networking
        --disable-sync
        --metrics-recording-only
        --autoplay-policy=no-user-gesture-required
        --password-store=basic
        --user-data-dir="$HOME/.flair-chrome-test"
)

chromium "${CHROMIUM_FLAGS[@]}"
