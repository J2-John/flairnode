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

# Where this script actually lives, for invoking its siblings. Resolved from
# the script's own path rather than $PWD, because XDG autostart gives us no
# guaranteed working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Must match THEME_NAME in install-cursor-theme.sh, which owns this name.
CURSOR_THEME_NAME="flair-blank"

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

# A stale SingletonLock (and friends) in the profile dir survives a reboot,
# and after a hostname rename mid-provisioning Chromium reads it as "profile
# in use on another computer" and refuses to launch entirely -> silent
# desktop instead of kiosk. Safe to always clear at script start: this
# profile exists only for this one kiosk Chromium instance, so any lock
# present here is stale by definition (fresh boot or a prior unclean exit).
rm -f "$HOME/.flair-chrome-test/Singleton"*

# Hide the mouse cursor. Three independent layers, because on FN-00006 the
# first two each turned out to cover only part of the problem:
#
#  1. render.html's own `cursor: none` CSS - governs the pointer while it is
#     over Chromium's own surface. Kept, still correct, not sufficient on
#     its own: labwc draws a pointer regardless.
#  2. unclutter, X11 sessions only (below) - inert on Wayland, which is what
#     these units actually run.
#  3. the blank cursor theme installed just below - the compositor-level
#     fix, and the one that addresses labwc directly.
#
# Installing the theme is idempotent and near-instant, so it runs on every
# launch rather than being gated on a marker file: a unit that was reimaged,
# had its home directory reset, or shipped before this change self-heals on
# its next boot with no human touch. It stays silent unless it changes
# something.
#
# Never fatal: a missing or failing cursor install is cosmetic, and a unit
# that can't hide its pointer must still come up playing content.
if [ -x "$SCRIPT_DIR/install-cursor-theme.sh" ]; then
        "$SCRIPT_DIR/install-cursor-theme.sh" || echo "Cursor theme install failed - continuing to kiosk launch anyway."
else
        echo "install-cursor-theme.sh missing or not executable at $SCRIPT_DIR - skipping cursor theme install."
fi

# Belt and braces for the client side: labwc exports XCURSOR_THEME to what
# it spawns, but this script is started by XDG autostart, so we cannot
# assume that inheritance reaches us. Setting it here guarantees Chromium
# and Xwayland resolve cursors through the blank theme too, whatever the
# compositor did or didn't hand down.
export XCURSOR_THEME="$CURSOR_THEME_NAME"

# XDG_SESSION_TYPE is set by the session manager at login for both session
# types, so branching on it costs nothing on Wayland (falls through, no-op).
if [ "$XDG_SESSION_TYPE" = "x11" ]; then
        if command -v unclutter >/dev/null 2>&1; then
                unclutter -idle 0 &
        else
                echo "unclutter not installed - skipping X11 cursor-hide (relying on render.html's cursor:none)."
        fi
fi

# Session/compositor identity, logged on every launch. Costs one line in
# `pm2 logs`-adjacent kiosk output and answers the first question any future
# cursor/display investigation has to ask, without needing a live SSH
# session on the unit at the time.
COMPOSITOR="$(pgrep -l -x 'labwc|wayfire|sway' 2>/dev/null | tr '\n' ' ')"
echo "Session: XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-unset}, compositor=${COMPOSITOR:-none}, XCURSOR_THEME=$XCURSOR_THEME"

chromium "${CHROMIUM_FLAGS[@]}"
