#!/usr/bin/env bash
#
# flair-status.sh - read-only health snapshot of a FlairNode.
#
# Assembled 2026-08-27 from the checks that were needed, ad hoc and over about
# eight round trips, to diagnose FN-00007. All of it in one place so the next
# occurrence costs one command.
#
# READ-ONLY BY CONSTRUCTION. It starts nothing, stops nothing, writes nothing,
# and needs no sudo. Safe to run on a production unit that is playing.
#
# Usage:   ./flair-status.sh
#          ./flair-status.sh > /tmp/status.txt 2>&1     (to paste somewhere)

# Deliberately NOT set -e: a missing optional tool must not truncate the report.
# Every section is expected to survive its own failure.

hr() { printf '\n=== %s ===\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

printf 'flair-status  %s  on %s\n' "$(date -Is)" "$(hostname)"

hr "IDENTITY AND PLATFORM"
tr -d '\0' < /proc/device-tree/model 2>/dev/null; echo
grep -E 'PRETTY_NAME' /etc/os-release
echo "kernel:   $(uname -r)  $(uname -m)"
# id.json holds the security code (claim PIN) - report presence only, never contents.
[ -f "$HOME/id.json" ] && echo "id.json:  present at ~/id.json" || echo "id.json:  MISSING at ~/id.json"
[ -f "$HOME/flairnode/VERSION" ] \
  && echo "VERSION:  $(cat "$HOME/flairnode/VERSION")" \
  || echo "VERSION:  absent (firmware_version is a hardcoded constant - known debt)"

hr "LOAD AND UPTIME"
uptime
echo "cores:    $(nproc)"
# Processes in uninterruptible sleep inflate load average without using CPU.
# Wedged vc4 HDMI HPD threads show up here and are the tell for the audio-
# infoframe loop (see claude/flairnode-hdmi-audio-load-finding.md).
echo "--- processes in D state (uninterruptible) ---"
ps -eo state,pid,comm | awk '$1 ~ /^D/ { print }' || true
ps -eo state,pid,comm | awk '$1 ~ /^D/' | grep -q . || echo "(none - good)"

hr "TOP CPU"
ps -eo pid,pcpu,pmem,etimes,args --sort=-pcpu 2>/dev/null | head -8 | cut -c1-130

hr "THERMAL AND POWER"
if have vcgencmd; then
        vcgencmd measure_temp
        # Anything other than 0x0 means throttling or undervoltage has occurred.
        vcgencmd get_throttled
else
        echo "vcgencmd unavailable"
fi

hr "MEMORY AND DISK"
free -h | head -2
df -h / /boot/firmware 2>/dev/null | grep -v '^Filesystem' | awk '{printf "%-20s %6s used of %-6s (%s)\n", $6, $3, $2, $5}'

hr "AUDIO (must be EMPTY on a FlairNode)"
# Any playback device here means dtoverlay=vc4-kms-v3d,noaudio is not applied,
# and wireplumber will loop preparing HDMI audio against a wedged connector.
if have aplay; then
        if aplay -l 2>/dev/null | grep -q '^card'; then
                echo "PROBLEM: HDMI audio devices are registered -"
                aplay -l 2>/dev/null | grep '^card'
                echo "  -> add ,noaudio to dtoverlay=vc4-kms-v3d in /boot/firmware/config.txt"
        else
                echo "no audio devices (correct)"
        fi
else
        echo "aplay unavailable"
fi
echo "--- infoframe warnings since boot (want 0) ---"
dmesg 2>/dev/null | grep -c 'vc4_hdmi_write_infoframe' || echo "dmesg unreadable without sudo"

hr "DISPLAY"
for f in /sys/class/drm/card*-HDMI-A-*/status; do
        [ -e "$f" ] || continue
        conn="$(basename "$(dirname "$f")")"
        echo "$conn: $(cat "$f") / $(cat "$(dirname "$f")/enabled" 2>/dev/null)"
done
# A connector with no modes cannot have read EDID, so its resolution is a guess.
for f in /sys/class/drm/card*-HDMI-A-*/modes; do
        [ -e "$f" ] || continue
        conn="$(basename "$(dirname "$f")")"
        echo "$conn preferred mode: $(head -1 "$f" 2>/dev/null || echo 'NONE - no EDID')"
done

hr "SESSION"
LABWC_PID="$(pgrep -f 'labwc' | head -1)"
if [ -n "$LABWC_PID" ]; then
        echo "labwc pid $LABWC_PID"
        # Read the DESKTOP session's environment, not this shell's. Over ssh the
        # local XDG_SESSION_TYPE is meaningless and will mislead you.
        tr '\0' '\n' < "/proc/$LABWC_PID/environ" 2>/dev/null \
          | grep -E '^(XDG_SESSION_TYPE|WAYLAND_DISPLAY|XDG_RUNTIME_DIR)=' || echo "(environ unreadable)"
else
        echo "labwc NOT RUNNING"
fi
have wtype && echo "wtype:    installed" || echo "wtype:    MISSING - cursor will be visible on the wall"

hr "KIOSK BROWSER"
# --type= filters out renderer/gpu/utility children; we want top-level browsers.
KIOSK_COUNT="$(pgrep -a -f 'user-data-dir=' 2>/dev/null | grep -v -- '--type=' | grep -c . )"
echo "top-level kiosk chromium processes: $KIOSK_COUNT  (want exactly 1)"
[ "$KIOSK_COUNT" -gt 1 ] && echo "  PROBLEM: more than one browser will fight over the single render socket slot"
echo "--- autostart registrations (two would be a double-launch hazard) ---"
ls -1 "$HOME/.config/autostart/" 2>/dev/null | sed 's/^/  XDG:   /' || echo "  XDG:   none"
[ -f "$HOME/.config/labwc/autostart" ] && echo "  labwc: present" || echo "  labwc: none"

hr "NODE PROCESS"
if have pm2; then
        pm2 list 2>/dev/null | grep -E 'name|flairnode|─' | head -6
else
        echo "pm2 unavailable"
fi

hr "RENDER SOCKET (port 9223)"
if have ss; then
        ss -ltn 2>/dev/null | grep -q ':9223' && echo "listening: yes" || echo "listening: NO - RenderSocketClient is not up"
        EST="$(ss -tn 2>/dev/null | grep -c ':9223')"
        echo "established connections: $EST  (want 1 - the browser is attached)"
else
        echo "ss unavailable"
fi

hr "CONTENT"
if [ -d "$HOME/flairnode/content" ]; then
        echo "files: $(ls -1 "$HOME/flairnode/content" 2>/dev/null | wc -l)   size: $(du -sh "$HOME/flairnode/content" 2>/dev/null | cut -f1)"
        ls -lt "$HOME/flairnode/content" 2>/dev/null | head -4 | tail -3
else
        echo "content directory MISSING"
fi

hr "CODE DRIFT"
# update.sh rsyncs over the working tree without telling git, so the commit a
# device claims to be on is not necessarily the code it is running. Confirmed on
# FN-00007: HEAD at a pre-guard commit, working tree carrying the guard.
if [ -d "$HOME/flairnode/.git" ]; then
        ( cd "$HOME/flairnode" || exit
          echo "HEAD:     $(git log --oneline -1 2>/dev/null)"
          DIRTY="$(git status --porcelain 2>/dev/null | grep -c .)"
          echo "modified: $DIRTY file(s) vs HEAD"
          [ "$DIRTY" -gt 0 ] && git status --porcelain 2>/dev/null | head -10 | sed 's/^/  /'
          echo "NOTE: git write commands here would revert rsync-delivered changes." )
else
        echo "no git repository (unzip-installed unit)"
fi

hr "END"
