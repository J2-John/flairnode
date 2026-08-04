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

# A stale SingletonLock (and friends) in the profile dir survives a reboot,
# and after a hostname rename mid-provisioning Chromium reads it as "profile
# in use on another computer" and refuses to launch entirely -> silent
# desktop instead of kiosk. Safe to always clear at script start: this
# profile exists only for this one kiosk Chromium instance, so any lock
# present here is stale by definition (fresh boot or a prior unclean exit).
rm -f "$HOME/.flair-chrome-test/Singleton"*

# Hide the mouse cursor. Two layers, split by session type, because neither
# one covers both:
#
#  1. render.html's own `cursor: none` CSS - the X11 layer. Under X11 the
#     fullscreen page content is what draws the visible pointer, so the CSS
#     rule is sufficient there. Left alone: it is correct, and it is what
#     legacy X11 units rely on.
#  2. labwc's HideCursor keybind, fired once at startup (below) - the
#     Wayland layer, and the only thing that works on a Pi 5.
#
# Why the CSS cannot cover Wayland: the Pi 5's HDMI CEC receivers register
# as POINTER devices. /proc/bus/input/devices shows vc4-hdmi-0 and
# vc4-hdmi-1 reporting PROP=20 (INPUT_PROP_POINTING_STICK), EV_REL, and
# REL=3 (REL_X + REL_Y). libinput therefore sees a pointer, wlroots creates
# a cursor for it, labwc draws the arrow - and nothing ever moves it,
# because no CEC remote is sending motion. This happens with no mouse
# attached at all and is intrinsic to the Pi 5 HDMI driver. Under Wayland
# the compositor owns the cursor, and Chromium can only override it via
# wl_pointer.set_cursor in response to a pointer event on its surface - a
# pointer that never moves never triggers that path, so the page's CSS
# never gets a say. Confirmed on FN-0000001 and FN-00009 (Raspberry Pi OS
# Bookworm, labwc 0.9.8).
#
# A udev rule setting LIBINPUT_IGNORE_DEVICE=1 on the vc4-hdmi devices was
# tested on hardware and did NOT work - the cursor stayed on screen. Don't
# re-attempt it.
#
# So we drive labwc's own HideCursor action instead: install a keybind for
# it, then press that keybind once with wtype. One shot at startup is
# permanent in practice, because the cursor only returns on real pointer
# input and nothing on a production wall generates any - which is also why
# there's no swayidle here.
#
# Raspberry Pi OS launches labwc through /usr/bin/labwc-pi, which passes
# -m (--merge-config). That is what makes the minimal rc.xml below safe: it
# merges with /etc/xdg/labwc/rc.xml instead of replacing it, so we add one
# keybind without discarding the distro's entire config.
LABWC_RC="$HOME/.config/labwc/rc.xml"

if [ "$XDG_SESSION_TYPE" = "wayland" ]; then
        if [ ! -f "$LABWC_RC" ]; then
                echo "Installing labwc cursor-hide keybind at $LABWC_RC..."
                mkdir -p "$(dirname "$LABWC_RC")"
                cat > "$LABWC_RC" <<'LABWCRC'
<?xml version="1.0"?>
<labwc_config>
  <keyboard>
    <keybind key="A-W-h">
      <action name="HideCursor" />
      <action name="WarpCursor" x="-1" y="-1" />
    </keybind>
  </keyboard>
</labwc_config>
LABWCRC
                labwc --reconfigure 2>/dev/null || pkill -HUP labwc
                sleep 1
        elif ! grep -q HideCursor "$LABWC_RC"; then
                echo "WARNING: $LABWC_RC exists but has no HideCursor keybind - cursor will stay visible."
        fi

        if command -v wtype >/dev/null 2>&1; then
                wtype -M alt -M logo h -m alt -m logo
        else
                echo "WARNING: wtype not installed - cannot hide cursor (sudo apt install wtype)."
        fi
fi

# Legacy X11 units only. Never fires on a Pi 5, which runs Wayland - this
# branch is not Pi 5 cursor coverage. XDG_SESSION_TYPE is set by the session
# manager at login for both session types, so this costs nothing elsewhere.
if [ "$XDG_SESSION_TYPE" = "x11" ]; then
        if command -v unclutter >/dev/null 2>&1; then
                unclutter -idle 0 &
        else
                echo "unclutter not installed - skipping X11 cursor-hide (relying on render.html's cursor:none)."
        fi
fi

chromium "${CHROMIUM_FLAGS[@]}"
