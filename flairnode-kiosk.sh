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

# USB WI-FI PROVISIONING. Deliberately placed AFTER both concurrency guards
# above: a duplicate invocation must exit before this block mounts anything or
# runs anything, because mounting and executing are not idempotent the way the
# autostart install is.
#
# SECURITY, STATED SO IT IS NOT WIDENED BY ACCIDENT: this executes a script
# carried on removable media, as root. That is a physical-access-to-root path by
# construction, and it is accepted deliberately — the field case is a technician
# at an install with no network yet, who needs to hand a wall its Wi-Fi
# credentials with nothing but a USB stick. Anyone who can plug a stick into
# this unit can already take the SD card, so this grants no capability that
# physical access did not already carry. What it must never become is a REMOTE
# path: nothing here may accept a filename, a URL, or a device from anywhere but
# a locally mounted volume, and the mount point must stay a fixed literal. Do
# not parameterise it, do not read it from a config file, do not let a payload
# name its own script.
#
# Every failure here is non-fatal and logged. A wall that cannot provision Wi-Fi
# must still play — a black screen at a customer site is worse than a unit that
# stayed on the network it already had.
#
# EVERY sudo BELOW IS `sudo -n`, AND THE -n IS NOT OPTIONAL. This block runs from
# XDG autostart, before chromium, with no terminal attached. On a unit that lacks
# passwordless sudo a bare `sudo` blocks on a password prompt that nobody can
# ever answer, and the kiosk never launches — a fail-CLOSED path sitting in the
# middle of a fail-open design, and the first sudo this script has ever had. With
# -n, sudo refuses immediately ("sudo: a password is required") and every one of
# those refusals lands on a warn-and-continue branch below, so the worst case on
# such a unit is "no Wi-Fi provisioning, kiosk starts normally" instead of a black
# wall. Do not drop the -n. The mount call deliberately does NOT redirect stderr,
# which is the only reason that message reaches the log at all — the [ -b ] guard
# means a stickless unit never reaches mount, so the only errors it can print are
# ones worth reading. Do not add 2>/dev/null back to it.
#
# Paths are anchored to this script's own location on disk, never to $PWD — the
# same treatment IdManager.mjs got in 6f6bd3c. A cwd-relative path here would
# resolve against whatever directory the desktop session happened to launch the
# autostart entry from, which is not knowable and not stable.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

USB_MOUNT="/media/usb"
USB_DEVICE="/dev/sda1"
USB_WIFI_SRC="$USB_MOUNT/connectWiFi.sh"
CONNECT_SCRIPT="$SCRIPT_DIR/connect.sh"

if mountpoint -q "$USB_MOUNT" 2>/dev/null; then
        echo "[usb-wifi] $USB_MOUNT is already mounted - using it as-is."
elif [ -b "$USB_DEVICE" ]; then
        sudo -n mkdir -p "$USB_MOUNT" 2>/dev/null
        if sudo -n mount "$USB_DEVICE" "$USB_MOUNT"; then
                echo "[usb-wifi] mounted $USB_DEVICE at $USB_MOUNT."
        else
                echo "WARNING: [usb-wifi] mount of $USB_DEVICE at $USB_MOUNT failed - skipping Wi-Fi provisioning, continuing to the kiosk."
        fi
else
        echo "[usb-wifi] no block device at $USB_DEVICE - no USB stick present, skipping Wi-Fi provisioning."
fi

# -s, not a find(1) command substitution: the source must exist AND be
# non-empty before anything downstream touches the destination. The only shell
# redirect below writes to a TEMP file, never to $CONNECT_SCRIPT, so an absent
# or empty source cannot truncate an existing connect.sh as a side effect of
# merely testing for it.
if [ -s "$USB_WIFI_SRC" ]; then
        # CRLF STRIP — LOAD-BEARING, DO NOT REMOVE. A connectWiFi.sh authored on
        # Windows and carried on a FAT thumb drive has CRLF line endings. Linux
        # takes everything up to the first \n as the shebang's interpreter line,
        # so `#!/usr/bin/env bash` followed by \r\n asks env for a program named
        # literally "bash\r" and the script dies with
        #     env: 'bash\r': No such file or directory
        # before one line of it runs — on precisely the case this feature exists
        # for, a technician with a stick made on a Windows laptop. install(1) is
        # a byte-for-byte copy and will faithfully preserve those CRs, so the
        # strip has to happen before it, not instead of it.
        #
        # Strip to a temp file, then install FROM the temp file. That keeps all
        # three properties at once: the CRs are gone, the redirect can never
        # truncate the destination, and install(1) still performs the final
        # write so mode and ownership are set as the file appears rather than
        # after it — never briefly world-writable with root about to run it.
        # 700 root:root: a script root executes must not be writable by the
        # user it protects against. mktemp creates the temp file 0600.
        #
        # tr reads the stick unprivileged on purpose — only the install needs
        # root. If a future mount arrives root-only-readable the tr simply
        # fails, which is handled below and still reaches the kiosk.
        USB_WIFI_TMP="$(mktemp)"

        if ! tr -d '\r' < "$USB_WIFI_SRC" > "$USB_WIFI_TMP" || [ ! -s "$USB_WIFI_TMP" ]; then
                echo "WARNING: [usb-wifi] could not read or line-ending-normalise $USB_WIFI_SRC - continuing to the kiosk."
        elif sudo -n install -m 700 -o root -g root "$USB_WIFI_TMP" "$CONNECT_SCRIPT"; then
                echo "[usb-wifi] installed $CONNECT_SCRIPT as 700 root:root, CRLF stripped - running it."

                if sudo -n "$CONNECT_SCRIPT"; then
                        echo "[usb-wifi] Wi-Fi provisioning script completed successfully."
                else
                        echo "WARNING: [usb-wifi] $CONNECT_SCRIPT exited non-zero - continuing to the kiosk anyway."
                fi
        else
                echo "WARNING: [usb-wifi] could not install $CONNECT_SCRIPT from $USB_WIFI_SRC - continuing to the kiosk."
        fi

        rm -f "$USB_WIFI_TMP"
else
        echo "[usb-wifi] no non-empty $USB_WIFI_SRC found - nothing to provision. Any existing $CONNECT_SCRIPT is left untouched."
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
