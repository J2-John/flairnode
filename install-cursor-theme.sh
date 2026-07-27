#!/usr/bin/env bash

# Flair Node blank-cursor-theme installer.
#
# Installs a fully transparent Xcursor theme ("flair-blank") for the current
# user and points labwc at it, so the compositor's own pointer image is
# invisible. Idempotent by design: safe to run on every kiosk launch, does
# nothing and prints nothing when the unit is already set up.
#
# WHY THIS EXISTS
# A kiosk unit must never show a mouse pointer. Two earlier attempts didn't
# fully solve it:
#   1. render.html's `cursor: none` CSS — still in place, still correct, but
#      it only governs the pointer over Chromium's own surface.
#   2. Suppressing the input devices (a udev rule setting
#      LIBINPUT_IGNORE_DEVICE=1 on the vc4-hdmi-* nodes) — verified applied
#      on FN-00006 and the cursor STILL rendered, so labwc draws a pointer
#      regardless of whether any pointer device exists. That rule was backed
#      out; device suppression is a dead end.
# labwc has no "hide the cursor" setting: its only native control is the
# HideCursor action, which is a manual keybind and re-shows on the next
# input event (labwc/labwc discussion #3052 — auto-hide-on-idle is
# explicitly unsupported). What labwc DOES honour is the cursor theme, so
# the durable fix is to give it a theme whose every cursor is a fully
# transparent image. Nothing is hidden; there is simply nothing to draw.
#
# Note also that these units always look like they have a pointer attached
# even with nothing plugged in: the HDMI CEC input devices declare relative
# X/Y axes (REL=3), so libinput classifies them as pointers on every unit.
#
# The theme's one image is shipped prebuilt at Assets/cursors/blank.xcursor
# (see bench/make-blank-cursor.mjs for how it's generated and why). It is
# copied, never generated here, so a unit needs no cursor-authoring
# toolchain — no xcursorgen, no ImageMagick, no build step on the Pi.

set -u

THEME_NAME="flair-blank"

# Anchored to this script's own location on disk, never to $PWD — same
# reason IdManager.mjs resolves id.json from import.meta.url: this runs
# from XDG autostart, whose working directory is not ours to assume.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_CURSOR="$SCRIPT_DIR/Assets/cursors/blank.xcursor"

# Canonical install location. ~/.local/share/icons is first in the default
# XCURSOR_PATH used by both wlroots (what labwc loads through) and current
# libXcursor (what Xwayland/GTK clients load through). ~/.icons gets a
# symlink below because it is the one directory present in *every* version
# of that search path, old and new.
THEME_DIR="$HOME/.local/share/icons/$THEME_NAME"
LEGACY_THEME_LINK="$HOME/.icons/$THEME_NAME"

LABWC_CONFIG_DIR="$HOME/.config/labwc"
ENV_FILE="$LABWC_CONFIG_DIR/environment"
SYSTEM_ENV_FILE="/etc/xdg/labwc/environment"

# Cursor names to cover. A theme resolves a cursor by exact filename, so a
# name we don't ship falls through to whatever the client picks instead —
# i.e. a visible pointer. Hence the deliberately generous list: the
# freedesktop/CSS names, the legacy X11 core names, and the MD5-hash
# aliases that GTK/Qt/Chromium still request by hash. Every one of these
# becomes a symlink to the same transparent image, so breadth is free.
CURSOR_NAMES=(
	# default pointer
	default left_ptr arrow top_left_arrow right_ptr X_cursor x-cursor
	# links / hands
	pointer hand hand1 hand2 pointing_hand
	e29285e634086352946a0e7090d73106 9d800788f1b08800ae810202380a0822
	# text
	text xterm ibeam vertical-text
	# busy
	wait watch progress left_ptr_watch
	0426c94ea35c87780ff01dc239897213 3ecb610c1bf2410f44200f48c40d3599
	00000000000000020006000e7e9cc0ff 08e8e1c95fe2fc01f976f1e063a24ccd
	# help
	help question_arrow whats_this
	d9ce0ab605698f320427677b458ad60b 5c6cd98b3f3ebcb1f9c7f1c204630408
	# precision / cells
	crosshair cross tcross cross_reverse diamond_cross cell plus dotbox draped_box target icon
	# move
	move fleur all-scroll size_all
	4498f0e0c1937ffe01fd06f973665830 9081237383d90e509aa00f00170e968f
	# grab / drag and drop
	grab grabbing openhand closedhand
	dnd-none dnd-move dnd-copy dnd-link dnd-no-drop dnd-ask
	fcf21c00b30f7e3f83fe0dfd12e71cff 5aca4d189052212118709018842178c0 208530c400c041818281048008011002
	# copy / alias
	copy alias link
	1081e37283d90000800003c07f3ef6bf 6407b0e94181790501fd1e167b474872
	3085a0e285430894940527032f8b26df 640fb0e74195791501fd1ed57b41487f
	# forbidden
	no-drop forbidden not-allowed crossed_circle circle pirate
	03b6e0fcb3499374a867c041f52298f0
	# menus / zoom
	context-menu zoom-in zoom-out
	# resize — CSS names
	col-resize row-resize ew-resize ns-resize nesw-resize nwse-resize
	n-resize s-resize e-resize w-resize ne-resize nw-resize se-resize sw-resize
	# resize — X11 core names
	sb_h_double_arrow sb_v_double_arrow split_h split_v
	size_hor size_ver size_fdiag size_bdiag
	top_side bottom_side left_side right_side
	top_left_corner top_right_corner bottom_left_corner bottom_right_corner
	ul_angle ur_angle ll_angle lr_angle
	14fef782d02440884392942c11205230 2870a09082c103050810ffdffffe0204
	c7088f0f3e6c8088236ef8e1e3e70000 043a9f68147c53184671403ffa811cc5
	028006030e0e7ebffc7f7070c0600140 fcf1c3c7cd4491d801f1e1c78f100000
	# scrollbar / misc legacy
	sb_left_arrow sb_right_arrow sb_up_arrow sb_down_arrow
	based_arrow_down based_arrow_up center_ptr
	left_tee right_tee top_tee bottom_tee up-arrow down-arrow
	pencil dot hourglass
)

changed=0

note() {
	# only speaks up when something actually changed, so a steady-state
	# unit's kiosk launch stays quiet
	changed=1
	echo "[cursor-theme] $1"
}

if [ ! -f "$SOURCE_CURSOR" ]; then
	echo "[cursor-theme] ERROR: $SOURCE_CURSOR not found — cursor theme NOT installed." >&2
	exit 1
fi


# ---- 1. the theme itself ----

mkdir -p "$THEME_DIR/cursors"

# The single real cursor file. Every name below is a symlink to it, so the
# 11 KB image exists once on disk.
if ! cmp -s "$SOURCE_CURSOR" "$THEME_DIR/cursors/$THEME_NAME"; then
	cp "$SOURCE_CURSOR" "$THEME_DIR/cursors/$THEME_NAME"
	note "installed transparent cursor image into $THEME_DIR/cursors/"
fi

for name in "${CURSOR_NAMES[@]}"; do
	# -f so a wrong/stale entry from an earlier run is replaced rather than
	# skipped; relative target so the theme dir stays relocatable
	if [ ! -L "$THEME_DIR/cursors/$name" ] || [ "$(readlink "$THEME_DIR/cursors/$name")" != "$THEME_NAME" ]; then
		ln -sf "$THEME_NAME" "$THEME_DIR/cursors/$name"
		note "linked cursor name '$name'"
	fi
done

# No Inherits= key on purpose: inheriting any other theme would reintroduce
# a visible pointer for every name this theme doesn't define.
INDEX_THEME="[Icon Theme]
Name=$THEME_NAME
Comment=Fully transparent cursor theme for Flair Node kiosk displays"

if [ "$(cat "$THEME_DIR/index.theme" 2>/dev/null)" != "$INDEX_THEME" ]; then
	printf '%s\n' "$INDEX_THEME" > "$THEME_DIR/index.theme"
	note "wrote $THEME_DIR/index.theme"
fi

# ~/.icons mirror for any consumer still using the older search path.
mkdir -p "$HOME/.icons"
if [ ! -e "$LEGACY_THEME_LINK" ] && [ ! -L "$LEGACY_THEME_LINK" ]; then
	ln -s "$THEME_DIR" "$LEGACY_THEME_LINK"
	note "linked $LEGACY_THEME_LINK -> $THEME_DIR"
fi


# ---- 2. point labwc at it ----
#
# labwc takes its cursor theme from XCURSOR_THEME, read from its
# environment file — there is NO rc.xml cursor-theme element (the
# <theme><cursor type="none"/> block seen in the wild, e.g. labwc issue
# #1535, is not real labwc config and does nothing).
#
# The seeding step below matters: by default labwc reads only the FIRST
# environment file it finds, checking $XDG_CONFIG_HOME/labwc before
# /etc/xdg/labwc. Creating a user file from scratch would therefore shadow
# the distro's entire system environment file — every keyboard/cursor/GTK
# setting Raspberry Pi OS ships in it — rather than adding one line to it.
# So: seed from the system file when creating ours, then edit ours.

mkdir -p "$LABWC_CONFIG_DIR"

if [ ! -f "$ENV_FILE" ]; then
	if [ -f "$SYSTEM_ENV_FILE" ]; then
		cp "$SYSTEM_ENV_FILE" "$ENV_FILE"
		note "seeded $ENV_FILE from $SYSTEM_ENV_FILE (a user file shadows the system one)"
	else
		: > "$ENV_FILE"
		note "created $ENV_FILE"
	fi
fi

# Syntax per labwc-config(5): bare variable=value lines, '#' comments on
# their own line only — trailing comments are NOT supported.
if grep -qE '^[[:space:]]*XCURSOR_THEME=' "$ENV_FILE"; then
	if [ "$(grep -E '^[[:space:]]*XCURSOR_THEME=' "$ENV_FILE" | tail -n 1 | sed -E 's/^[[:space:]]*XCURSOR_THEME=//')" != "$THEME_NAME" ]; then
		sed -i -E "s|^[[:space:]]*XCURSOR_THEME=.*|XCURSOR_THEME=$THEME_NAME|" "$ENV_FILE"
		note "set XCURSOR_THEME=$THEME_NAME in $ENV_FILE"
	fi
else
	printf '\n# Flair kiosk: fully transparent cursor theme (see install-cursor-theme.sh)\nXCURSOR_THEME=%s\n' "$THEME_NAME" >> "$ENV_FILE"
	note "added XCURSOR_THEME=$THEME_NAME to $ENV_FILE"
fi


# ---- 3. apply to the running session, if we can ----
#
# labwc re-reads its environment file on SIGHUP (labwc-config(5): "all
# configuration and theme files except autostart and shutdown are re-loaded
# on receiving signal SIGHUP"), which is what --reconfigure sends. Treated
# as best-effort only: whether a running compositor re-loads an already
# resolved cursor theme is not documented, so the guaranteed path remains a
# session restart / reboot. Only fires when something changed, so a normal
# kiosk launch never pokes the compositor.

if [ "$changed" -eq 1 ] && command -v labwc >/dev/null 2>&1 && pgrep -x labwc >/dev/null 2>&1; then
	labwc --reconfigure >/dev/null 2>&1 || true
	echo "[cursor-theme] asked the running labwc to reconfigure — reboot if the pointer is still visible."
fi

exit 0
