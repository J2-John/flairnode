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

# Concurrency mutex, layer 1 of 2. Ordering here is deliberate: this sits after
# the autostart install above, because that block is idempotent and the manual
# arming step must keep installing the .desktop entry even when a kiosk is
# already running - and before the pgrep guard below.
#
# The lockfile lives directly in $HOME, deliberately NOT in ~/flairnode:
# update.sh rsyncs over that directory, so a lockfile there could be replaced
# underneath a running kiosk. Two scripts would then hold locks on two
# different inodes, both would think they won, and the mutex would be worse
# than useless because it would look like it was working.
#
# The fd is opened with exec and never closed, so the lock is held for the
# entire remaining life of this script - which is the life of the kiosk, since
# chromium runs in the foreground on the last line and this script stays its
# parent. The kernel releases the lock when the process exits, however it
# exits, so there is no stale lockfile to clean up and nothing to unwind after
# a crash or a kill -9.
#
# If flock is missing, or the lockfile cannot be opened at all, warn and carry
# on unguarded rather than exiting - the same fail-open convention this script
# already uses for wtype and unclutter. Neither case may turn into a silently
# blank wall: a mutex is worth less than a playing wall.
#
# The lockfile is probed with an ordinary command before exec goes near it,
# because a failed redirection on exec leaves fd 9 unopened and the flock that
# follows then fails with EBADF - which is indistinguishable here from "the
# lock is held", so the script would print the wrong reason and exit 0 without
# ever starting Chromium on a full or read-only $HOME. ': >>' is the probe: it
# opens the file the same way exec is about to, creates it when absent,
# truncates nothing, and reports failure by returning non-zero instead of
# taking the shell down with it. (True in bash's default mode, which is what
# the shebang gives us. Under set -o posix a redirection error on any special
# builtin - ':' and 'exec' alike - kills a non-interactive shell, so do not run
# this script through sh or with posix mode set.)
#
# In the probe, 2>/dev/null deliberately comes BEFORE the >> it is suppressing.
# Redirections are applied left to right, so with the natural-looking order the
# >> fails first and the shell's own "Permission denied" reaches the console
# before stderr has been silenced. Do not tidy these two back into order.
KIOSK_LOCKFILE="$HOME/.flairnode-kiosk.lock"

if ! command -v flock >/dev/null 2>&1; then
        echo "WARNING: flock not installed - starting without the startup mutex (it ships in util-linux)."
elif ! : 2>/dev/null >>"$KIOSK_LOCKFILE"; then
        echo "WARNING: cannot open $KIOSK_LOCKFILE for writing (full or read-only \$HOME?) - starting without the startup mutex."
else
        exec 9>"$KIOSK_LOCKFILE"

        if ! flock -n 9; then
                echo "Another copy of this script already holds $KIOSK_LOCKFILE - exiting without starting a second kiosk."
                exit 0
        fi
fi

# Concurrency guard, layer 2 of 2, and not redundant with the flock above.
# flock only covers two copies of *this script* racing at startup, and only for
# as long as a script is alive to hold the fd. It sees nothing when a kiosk
# Chromium outlived the script that launched it: a script that exited, crashed,
# or was killed leaves a running browser behind and no lock held at all. This
# pgrep check covers exactly that case, and in turn cannot cover the startup
# race, because at that moment neither copy has spawned chromium yet. Each
# closes the other's gap, so both are needed.
#
# What makes the check necessary at all is that nothing below this point is
# safe to run twice against the same profile, and the rm -f of Singleton*
# further down is the reason: that delete removes the live lock of an
# already-running kiosk Chromium, which is exactly the protection that would
# otherwise make a second chromium invocation hand its URL to the first
# instance and exit. Delete it out from under a running kiosk and you get two
# browsers fighting over one profile directory. So detect a live kiosk Chromium
# on this profile first, and bail out before reaching that rm.
#
# pgrep -a -f prints "PID full-command-line" for each match, which is what lets
# the matches be filtered:
#   - the pattern is the --user-data-dir value, because that is what identifies
#     *this* kiosk profile specifically rather than any other Chromium that
#     happens to be running on the unit.
#   - Chromium's helper processes (renderer, gpu-process, zygote, utility)
#     inherit --user-data-dir from the browser process, so they match the
#     pattern too. Only the browser process lacks --type=, so dropping every
#     line carrying --type= leaves just the one process worth reporting.
#   - this script's own PID is dropped defensively, so the guard can never
#     match itself no matter how the script was invoked.
KIOSK_PROFILE="$HOME/.flair-chrome-test"

RUNNING_KIOSK_PID="$(pgrep -a -f -- "user-data-dir=$KIOSK_PROFILE" \
        | grep -v -- '--type=' \
        | grep -v "^$$ " \
        | awk 'NR == 1 { print $1 }')"

if [ -n "$RUNNING_KIOSK_PID" ]; then
        echo "Kiosk Chromium is already running on $KIOSK_PROFILE as PID $RUNNING_KIOSK_PID - exiting without starting a second one."
        echo "Leaving $KIOSK_PROFILE/Singleton* in place: that lock is live, not stale, and deleting it is what would allow a second Chromium onto this profile."
        exit 0
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
