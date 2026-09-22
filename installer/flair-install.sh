#!/usr/bin/env bash
#
# flair-install.sh — install one FlairNode release, watch it, keep it or roll back.
#
# Shipped BY THE SERVER alongside every release and run over the tunnel. The
# device keeps no updater of its own worth versioning: the server always sends
# the installer it wants run. See claude/flairnode-updater-over-tunnel.md.
#
#   flair-install.sh [--enforce] [--watch SECONDS] <version> <release.tar.gz>
#
# WHAT IT DOES, in order:
#   1. refuses unless this unit is on the release layout
#   2. exits early if <version> is already current
#   3. unpacks the tarball BESIDE the live release, verifies it, renames into place
#   4. flips `current` to it (one atomic rename), remembers `previous`
#   5. restarts the app and asks the new app to reload the browser
#   6. watches the BROWSER's own render-health reports for --watch seconds
#   7. healthy  -> keeps it, prunes to two releases, records "ok"
#      unhealthy -> with --enforce flips back to previous and records "rolled_back";
#                   without --enforce (the default) records "would_roll_back" and
#                   keeps the new release
#
# THE DEFAULT IS OBSERVE-ONLY on purpose (doctrine 2.9): an automatic rollback
# driven by a health signal nobody has watched on real walls is a new way to
# take a wall down. The server passes --enforce once the observer has earned it.
# A bench unit can refuse enforcement with the file shared/.no-health-rollback.
#
# IT RUNS DETACHED. Started from an SSH session, it re-launches itself outside
# that session and returns immediately; the tunnel dropping, or the droplet
# redeploying, mid-watch cannot stop it. The device finishes the job on its own
# and the server reads the outcome when it next can. A safety mechanism must not
# share a failure mode with the thing it protects.
#
# EXIT CODES (of the detached run, recorded in the outcome)
#   0   installed and kept (ok, or would_roll_back in observe mode), or already current
#   1   refused before anything live was touched
#   2   rolled back
#   3   rollback itself failed — needs a person
#   10  this unit is not on the release layout
#   11  another install is already running
#
# Outcomes are appended as one JSON line each to shared/state/install-events.log
# and the latest is written to shared/state/install-outcome.json.

set -uo pipefail   # NOT -e: every failure is handled and recorded, never a silent exit.

# ---------------------------------------------------------------- configuration

ROOT="${FLAIR_ROOT:-$HOME/flairnode}"
RELEASES="$ROOT/releases"
SHARED="$ROOT/shared"
STATE="$SHARED/state"
CURRENT="$ROOT/current"

PM2_NAME="${FLAIR_PM2_NAME:-flairnode}"
RESTART_CMD="${FLAIR_RESTART_CMD:-pm2 restart $PM2_NAME --update-env}"

REQUIRED_FILES=(FlairNode.js package.json render.html Paths.mjs VERSION)
KEEP_RELEASES=2

WATCH_SECONDS=90
ENFORCE=0

# A report is healthy only if it is from a page loaded AFTER the swap, is
# recent, is not the error or boot screen, and — when a video is mounted — video
# frames actually reached the screen. This many consecutive healthy reports end
# the watch early as a pass.
HEALTHY_STREAK_NEEDED=3
# Normal report age is up to ~5 s (5 s reports). Beyond this, the report is stale.
REPORT_STALE_SECONDS=15
# The browser needs time to reconnect and reload before any report can exist.
GRACE_SECONDS="${FLAIR_GRACE_SECONDS:-30}"
# How often a report is sampled. The page reports every 5 s.
POLL_SECONDS="${FLAIR_POLL_SECONDS:-5}"

# ---------------------------------------------------------------- arguments

while [ $# -gt 0 ]; do
    case "$1" in
        --enforce) ENFORCE=1; shift ;;
        --watch)   WATCH_SECONDS="$2"; shift 2 ;;
        --)        shift; break ;;
        -*)        echo "unknown option $1" >&2; exit 1 ;;
        *)         break ;;
    esac
done

VERSION_WANTED="${1:-}"
TARBALL="${2:-}"

if [ -z "$VERSION_WANTED" ] || [ -z "$TARBALL" ]; then
    echo "usage: flair-install.sh [--enforce] [--watch SECONDS] <version> <release.tar.gz>" >&2
    exit 1
fi

# The version is a directory name and goes into JSON: allow only what a
# release helper produces.
if ! [[ "$VERSION_WANTED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "version '$VERSION_WANTED' is not X.Y.Z" >&2
    exit 1
fi

TARBALL="$(cd "$(dirname "$TARBALL")" 2>/dev/null && pwd)/$(basename "$TARBALL")"

# ---------------------------------------------------------------- detach

# Re-launch outside the calling session, then return at once. systemd-run gives
# the run a queryable unit name when the user has a systemd instance; setsid is
# the fallback. Either way the parent's SSH session ending does not reach it.
if [ -z "${FLAIR_INSTALL_DETACHED:-}" ]; then
    mkdir -p "$STATE"
    LAUNCH_LOG="$STATE/install-$VERSION_WANTED.log"
    ARGS=()
    [ "$ENFORCE" = 1 ] && ARGS+=(--enforce)
    ARGS+=(--watch "$WATCH_SECONDS" "$VERSION_WANTED" "$TARBALL")

    if [ -z "${FLAIR_NO_SYSTEMD:-}" ] && command -v systemd-run >/dev/null 2>&1 \
        && systemd-run --user --quiet --collect --unit="flair-install-probe-$$" /bin/true >/dev/null 2>&1; then
        # StandardOutput/StandardError: the run's own log goes to the SAME file
        # the setsid path writes and the line below names. Without them it went
        # to the systemd journal, and on the bench Pi 4 (2026-09-22) the file
        # this message pointed at did not exist.
        systemd-run --user --quiet --collect --unit="flair-install-$VERSION_WANTED" \
            --setenv=FLAIR_INSTALL_DETACHED=1 --setenv=HOME="$HOME" --setenv=PATH="$PATH" \
            --property=StandardOutput="append:$LAUNCH_LOG" --property=StandardError="append:$LAUNCH_LOG" \
            /bin/bash "$0" "${ARGS[@]}" >/dev/null 2>&1 \
            && { echo "STARTED systemd unit flair-install-$VERSION_WANTED; log $LAUNCH_LOG"; exit 0; }
    fi

    FLAIR_INSTALL_DETACHED=1 setsid -f /bin/bash "$0" "${ARGS[@]}" >>"$LAUNCH_LOG" 2>&1 < /dev/null
    echo "STARTED detached (setsid); log $LAUNCH_LOG"
    exit 0
fi

# ---------------------------------------------------------------- helpers

say() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [install $VERSION_WANTED] $*"; }

# The directory render health is written to — the same first-writable choice
# RenderSocketClient.mjs makes. The reload marker lives beside it.
RAM_DIR=""
for d in /dev/shm /run/shm /tmp; do
    if [ -w "$d" ]; then RAM_DIR="$d"; break; fi
done
RAM_DIR="${FLAIR_RAM_DIR:-$RAM_DIR}"
HEALTH_FILE="$RAM_DIR/flairnode-render-health.json"
RELOAD_MARKER="$RAM_DIR/flairnode-reload-browser"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r'; }

STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
FROM_VERSION=""

# Record the result: one line appended to the event log (never rewritten), and
# the latest written atomically for the server to read. Then exit.
finish() {
    local code="$1" outcome="$2" detail="$3"
    mkdir -p "$STATE"
    local line
    line="{\"version\":\"$VERSION_WANTED\",\"from\":\"$(json_escape "$FROM_VERSION")\",\"outcome\":\"$outcome\",\"exit\":$code,\"enforce\":$ENFORCE,\"started_at\":\"$STARTED_AT\",\"finished_at\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"detail\":\"$(json_escape "$detail")\"}"
    echo "$line" >> "$STATE/install-events.log"
    echo "$line" > "$STATE/install-outcome.json.tmp" && mv -f "$STATE/install-outcome.json.tmp" "$STATE/install-outcome.json"
    say "FINISHED $outcome (exit $code): $detail"
    exit "$code"
}

version_of() { tr -dc '0-9.' < "$1/VERSION" 2>/dev/null; }

# Read one field from the flat health JSON. Numbers and simple strings only.
field() {
    local key="$1" file="$2"
    grep -o "\"$key\":[^,}]*" "$file" 2>/dev/null | head -1 | cut -d: -f2- | tr -d '"'
}

restart_app() {
    # Stale evidence is the classic false pass: delete the old build's report
    # before restarting, so only the new page can produce a healthy one.
    rm -f "$HEALTH_FILE"
    # Tell the NEW app to reload the browser once it connects: the page is
    # still the old release's render.html until it reloads through `current`.
    : > "$RELOAD_MARKER"
    say "restarting: $RESTART_CMD"
    bash -c "$RESTART_CMD" >/dev/null 2>&1
}

# Point `current` at a release with one atomic rename.
point_current_at() {
    local target="$1"
    ln -sfn "releases/$target" "$ROOT/.current.new" && mv -Tf "$ROOT/.current.new" "$CURRENT"
}

# ---------------------------------------------------------------- 1. layout

# Checked BEFORE taking the lock: the lock file lives in $ROOT, and a failed
# redirect on `exec` would end this script with no outcome recorded.
if [ ! -L "$CURRENT" ] || [ ! -d "$RELEASES" ] || [ ! -d "$SHARED" ]; then
    finish 10 refused "not on the release layout (need $CURRENT symlink, $RELEASES, $SHARED)"
fi

exec 9>"$ROOT/.install.lock"
if ! flock -n 9; then
    finish 11 refused "another install is already running"
fi

say "starting (enforce=$ENFORCE, watch=${WATCH_SECONDS}s)"

FROM_DIR="$(basename "$(readlink "$CURRENT")")"
FROM_VERSION="$FROM_DIR"

# ---------------------------------------------------------------- 2. already there

if [ "$FROM_DIR" = "$VERSION_WANTED" ]; then
    if [ "$(version_of "$CURRENT")" = "$VERSION_WANTED" ]; then
        finish 0 already_current "current is already $VERSION_WANTED; nothing touched"
    fi
    # The live folder is NAMED the target version but says it is something
    # else. Replacing it would mean deleting the code the wall is running.
    # Refuse and let a person look.
    finish 1 refused "current is releases/$FROM_DIR but its VERSION says '$(version_of "$CURRENT")' - not replacing a live release"
fi

# ---------------------------------------------------------------- 3. unpack beside, verify

[ -s "$TARBALL" ] || finish 1 refused "tarball $TARBALL missing or empty"

PARTIAL="$RELEASES/.$VERSION_WANTED.partial"
rm -rf "$PARTIAL"
mkdir -p "$PARTIAL" || finish 1 refused "cannot create $PARTIAL"

if ! tar -xzf "$TARBALL" -C "$PARTIAL" 2>/dev/null; then
    rm -rf "$PARTIAL"
    finish 1 refused "tarball did not extract"
fi

# Accept a tarball with or without one top-level folder.
if [ ! -f "$PARTIAL/FlairNode.js" ]; then
    INNER="$(find "$PARTIAL" -mindepth 1 -maxdepth 1 -type d | head -1)"
    if [ -n "$INNER" ] && [ -f "$INNER/FlairNode.js" ]; then
        shopt -s dotglob; mv "$INNER"/* "$PARTIAL"/; shopt -u dotglob; rmdir "$INNER"
    fi
fi

for f in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$PARTIAL/$f" ]; then
        rm -rf "$PARTIAL"
        finish 1 refused "release is missing $f"
    fi
done
[ -d "$PARTIAL/node_modules" ] || { rm -rf "$PARTIAL"; finish 1 refused "release has no node_modules"; }

# The version INSIDE the tarball must be the version asked for. This one check
# catches a stale or wrong artifact before anything live moves.
GOT="$(version_of "$PARTIAL")"
if [ "$GOT" != "$VERSION_WANTED" ]; then
    rm -rf "$PARTIAL"
    finish 1 refused "tarball VERSION is '$GOT', expected '$VERSION_WANTED'"
fi

if [ -e "$RELEASES/$VERSION_WANTED" ]; then
    # Left by an earlier attempt and not current (checked above): replace it.
    rm -rf "$RELEASES/$VERSION_WANTED"
fi
mv "$PARTIAL" "$RELEASES/$VERSION_WANTED" || finish 1 refused "could not move release into place"
say "unpacked and verified $VERSION_WANTED"

# ---------------------------------------------------------------- 4. swap

if ! point_current_at "$VERSION_WANTED"; then
    finish 1 refused "could not switch current to $VERSION_WANTED"
fi
ln -sfn "releases/$FROM_DIR" "$ROOT/.previous.new" && mv -Tf "$ROOT/.previous.new" "$ROOT/previous"
say "current -> $VERSION_WANTED (previous $FROM_DIR)"

# ---------------------------------------------------------------- 5. restart

SWAPPED_AT="$(date +%s)"
restart_app

# ---------------------------------------------------------------- 6. watch

# Every sample is classified and logged. "It failed" is not a diagnosis.
STREAK=0
VERDICT=""
LAST_CLASS=""
BEFORE_SESSION=""   # the old page's session was deleted with its file; any session now is new

while :; do
    NOW="$(date +%s)"
    ELAPSED=$((NOW - SWAPPED_AT))

    if [ "$ELAPSED" -ge "$WATCH_SECONDS" ]; then
        VERDICT="fail"
        break
    fi

    CLASS=""
    if [ ! -s "$HEALTH_FILE" ]; then
        CLASS="missing"
    else
        FILE_AGE=$(( NOW - $(stat -c %Y "$HEALTH_FILE" 2>/dev/null || echo 0) ))
        SCREEN="$(field screen "$HEALTH_FILE")"
        MOUNTED="$(field videos_mounted "$HEALTH_FILE")"
        VFRAMES="$(field video_frames "$HEALTH_FILE")"
        PFRAMES="$(field page_frames "$HEALTH_FILE")"

        if [ "$FILE_AGE" -gt "$REPORT_STALE_SECONDS" ]; then
            CLASS="stale"
        elif [ "$SCREEN" = "error" ]; then
            CLASS="errored"
        elif [ "$SCREEN" = "boot" ] || [ -z "$SCREEN" ]; then
            CLASS="waiting"
        elif [ "${PFRAMES:-0}" -le 0 ]; then
            CLASS="errored"
        elif [ "${MOUNTED:-0}" -gt 0 ] && [ "${VFRAMES:-0}" -le 0 ]; then
            CLASS="errored"   # a video on the wall and nothing reaching the screen
        else
            CLASS="ok"
        fi
    fi

    if [ "$CLASS" != "$LAST_CLASS" ]; then
        say "t+${ELAPSED}s health: $CLASS"
        LAST_CLASS="$CLASS"
    fi

    if [ "$CLASS" = "ok" ]; then
        STREAK=$((STREAK + 1))
        if [ "$STREAK" -ge "$HEALTHY_STREAK_NEEDED" ]; then
            VERDICT="pass"
            break
        fi
    else
        STREAK=0
        # Past the grace period, an error screen is conclusive on its own.
        if [ "$CLASS" = "errored" ] && [ "$ELAPSED" -ge "$GRACE_SECONDS" ]; then
            VERDICT="fail"
            break
        fi
    fi

    sleep "$POLL_SECONDS"
done

# ---------------------------------------------------------------- 7. keep or roll back

if [ "$VERDICT" = "pass" ]; then
    # Keep current and previous; delete older releases.
    ls -1 "$RELEASES" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | while read -r r; do
        if [ "$r" != "$VERSION_WANTED" ] && [ "$r" != "$FROM_DIR" ]; then
            rm -rf "${RELEASES:?}/$r"
        fi
    done
    finish 0 ok "healthy after $(( $(date +%s) - SWAPPED_AT ))s (last: $LAST_CLASS)"
fi

# The time actually taken, not the window's length: an error screen past the
# grace period ends the watch early, and on the bench Pi 4 (2026-09-22) a
# rollback decided at 31 s was recorded as "unhealthy after 90s window".
REASON="unhealthy after $(( $(date +%s) - SWAPPED_AT ))s of a ${WATCH_SECONDS}s window (last: ${LAST_CLASS:-none})"

if [ "$ENFORCE" != 1 ] || [ -e "$SHARED/.no-health-rollback" ]; then
    finish 0 would_roll_back "$REASON — observe mode, kept $VERSION_WANTED"
fi

say "ROLLING BACK to $FROM_DIR: $REASON"
if point_current_at "$FROM_DIR"; then
    restart_app
    finish 2 rolled_back "$REASON; restored $FROM_DIR"
fi
finish 3 rollback_failed "$REASON; could NOT restore $FROM_DIR — needs a person"
