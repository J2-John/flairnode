#!/usr/bin/env bash
#
# bench/install-check.sh — scenario tests for installer/flair-install.sh.
#
# Throwaway-tool convention, same as the other bench/ files: never shipped to a
# device, never run in production. Runs the REAL installer against real release
# layouts built in a temp dir. pm2 is replaced (FLAIR_RESTART_CMD) by a fake app
# that writes render-health reports shaped exactly like RenderSocketClient's,
# choosing healthy / error screen / frozen video / silent from a TEST_HEALTH
# file inside whichever release `current` points at — so a rollback really does
# bring the old behaviour back.
#
# What it cannot test, and the bench Pi 4 must: the real pm2, the real kiosk
# reload, systemd-run on the device, and a real tunnel dropping.
#
# Usage:  bash bench/install-check.sh

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Overridable so a deliberately broken COPY can be tested without touching the
# real file (mutation checks).
INSTALLER="${FLAIR_INSTALLER:-$REPO/installer/flair-install.sh}"
T="$(mktemp -d /tmp/flair-install-check-XXXX)"

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  PASS  $*"; }
bad()  { fail=$((fail+1)); echo "  FAIL  $*"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

# ---------------------------------------------------------------- fake app

cat > "$T/fake-app.sh" <<'EOF'
#!/usr/bin/env bash
# Writes a render-health report every second, like the real node app does
# every five. Behaviour comes from current/TEST_HEALTH.
ROOT="$1"; RAM="$2"
mode="$(cat "$ROOT/current/TEST_HEALTH" 2>/dev/null || echo good)"
session="s$RANDOM$RANDOM"
while :; do
    case "$mode" in
        good)   j="{\"page_session\":\"$session\",\"interval_ms\":5000,\"page_frames\":290,\"video_frames\":145,\"videos_mounted\":1,\"videos_playing\":1,\"screen\":\"content\",\"age_ms\":100}" ;;
        error)  j="{\"page_session\":\"$session\",\"interval_ms\":5000,\"page_frames\":290,\"video_frames\":0,\"videos_mounted\":0,\"videos_playing\":0,\"screen\":\"error\",\"age_ms\":100}" ;;
        frozen) j="{\"page_session\":\"$session\",\"interval_ms\":5000,\"page_frames\":290,\"video_frames\":0,\"videos_mounted\":1,\"videos_playing\":1,\"screen\":\"content\",\"age_ms\":100}" ;;
        serial) j="{\"page_session\":\"$session\",\"interval_ms\":5000,\"page_frames\":290,\"video_frames\":0,\"videos_mounted\":0,\"videos_playing\":0,\"screen\":\"serial\",\"age_ms\":100}" ;;
        none)   j="" ;;
    esac
    if [ -n "$j" ]; then echo "$j" > "$RAM/flairnode-render-health.json.tmp" && mv -f "$RAM/flairnode-render-health.json.tmp" "$RAM/flairnode-render-health.json"; fi
    sleep 1
done
EOF
chmod +x "$T/fake-app.sh"

# The stand-in for `pm2 restart flairnode` - and for what the BROWSER does next.
#
# On a real node the page is not restarted with the app. The old page stays on
# screen, reconnects to the new app within a second and keeps reporting under
# its OWN page_session until the new app tells it to reload (the reload marker),
# some seconds later. Until 2026-09-22 this stand-in replaced the reporter
# instantly, so the harness could never see an installer judge the OLD page -
# which is exactly what the bench Pi 4 then did (1.1.6 install: "t+1s health:
# ok", passed at 11 s, before the browser had reloaded).
#
# Modelled now: the old reporter (the old page) keeps running for
# FAKE_RELOAD_DELAY seconds; then, only if the installer left the reload marker,
# it is replaced by a new one loaded through `current` (the new page).
cat > "$T/fake-restart.sh" <<'EOF'
#!/usr/bin/env bash
ROOT="$1"; RAM="$2"
echo restart >> "$ROOT/.restarts"
[ -e "$RAM/flairnode-reload-browser" ] || exit 0
setsid -f "$(dirname "$0")/fake-reload.sh" "$ROOT" "$RAM" >/dev/null 2>&1 < /dev/null
EOF
chmod +x "$T/fake-restart.sh"

cat > "$T/fake-reload.sh" <<'EOF'
#!/usr/bin/env bash
ROOT="$1"; RAM="$2"
sleep "${FAKE_RELOAD_DELAY:-3}"
[ -f "$ROOT/.fake-app.pid" ] && kill "$(cat "$ROOT/.fake-app.pid")" 2>/dev/null
rm -f "$RAM/flairnode-reload-browser"
setsid -f "$(dirname "$0")/fake-app.sh" "$ROOT" "$RAM" >/dev/null 2>&1 < /dev/null
sleep 0.2
pgrep -f "fake-app.sh $ROOT " | tail -1 > "$ROOT/.fake-app.pid"
EOF
chmod +x "$T/fake-reload.sh"

# ---------------------------------------------------------------- fixtures

# A release directory: the files the installer requires, a node_modules folder,
# a VERSION and the behaviour the fake app should show when it runs.
make_release_dir() {   # dir version behaviour
    mkdir -p "$1/node_modules"
    for f in FlairNode.js package.json render.html Paths.mjs; do echo "// $2" > "$1/$f"; done
    printf '%s\n' "$2" > "$1/VERSION"
    echo "$3" > "$1/TEST_HEALTH"
}

make_tarball() {   # out.tar.gz version behaviour [version-inside]
    local d; d="$(mktemp -d "$T/tb-XXXX")"
    make_release_dir "$d/flairnode-$2" "${4:-$2}" "$3"
    tar -czf "$1" -C "$d" "flairnode-$2"
    rm -rf "$d"
}

# A unit on the release layout, RUNNING <version> healthily — its app already
# up and reporting, the way every real wall is right up until an update. This
# matters: an earlier version of this harness started units with no app and no
# health file, so there was never a previous build's report for the installer
# to mistake for the new one, and the stale-evidence guard was untested (a
# mutation removing it stayed green).
make_unit() {   # name version
    local root="$T/$1/flairnode" ram="$T/$1/ram"
    mkdir -p "$root/releases" "$root/shared" "$ram"
    make_release_dir "$root/releases/$2" "$2" good
    ln -s "releases/$2" "$root/current"
    setsid -f "$T/fake-app.sh" "$root" "$ram" >/dev/null 2>&1 < /dev/null
    sleep 0.3
    pgrep -f "fake-app.sh $root " | tail -1 > "$root/.fake-app.pid"
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$ram/flairnode-render-health.json" ] && break; sleep 0.2; done
    echo "$root"
}

stop_unit() { [ -f "$1/.fake-app.pid" ] && kill "$(cat "$1/.fake-app.pid")" 2>/dev/null; true; }

# Run the installer in the FOREGROUND (already "detached") so the exit code and
# timing are visible. Short timings so the suite runs in about a minute.
install() {   # root ram [installer args...]
    local root="$1" ram="$2"; shift 2
    FLAIR_INSTALL_DETACHED=1 FLAIR_ROOT="$root" FLAIR_RAM_DIR="$ram" \
    FLAIR_RESTART_CMD="$T/fake-restart.sh $root $ram" \
    FLAIR_GRACE_SECONDS=4 FLAIR_POLL_SECONDS=1 \
        bash "$INSTALLER" "$@" > "$root/.last-run.log" 2>&1
}

outcome() { grep -o '"outcome":"[^"]*"' "$1/shared/state/install-outcome.json" 2>/dev/null | cut -d'"' -f4; }
current_of() { basename "$(readlink "$1/current")"; }

# ---------------------------------------------------------------- scenarios

echo; echo "HEALTHY UPDATE"
R="$(make_unit a 1.0.0)"; make_tarball "$T/a.tgz" 1.1.0 good
OLD_SESSION="$(grep -o '"page_session":"[^"]*"' "$T/a/ram/flairnode-render-health.json")"
install "$R" "$T/a/ram" --enforce --watch 20 1.1.0 "$T/a.tgz"; rc=$?
is "exit 0" "$rc" 0
is "outcome ok" "$(outcome "$R")" ok
is "current is the new release" "$(current_of "$R")" 1.1.0
is "previous is the old release" "$(basename "$(readlink "$R/previous")")" 1.0.0
# The pass must come from the page loaded AFTER the swap: the reload marker has
# been used and the report that passed is not the old page's.
is "the browser was told to reload (marker consumed)" "$([ -e "$T/a/ram/flairnode-reload-browser" ] && echo left || echo consumed)" consumed
is "the page reporting is a new one, not the old page" "$([ "$(grep -o '"page_session":"[^"]*"' "$T/a/ram/flairnode-render-health.json")" != "$OLD_SESSION" ] && echo new || echo old)" new
is "the installer saw the old page and did not count it" "$(grep -c 'health: old-page' "$R/.last-run.log")" 1
is "no half-unpacked folder left behind" "$(ls -A "$R/releases" | grep -c partial)" 0
stop_unit "$R"

echo; echo "ERROR SCREEN, ENFORCED -> ROLLS BACK"
R="$(make_unit b 1.0.0)"; make_tarball "$T/b.tgz" 1.1.0 error
install "$R" "$T/b/ram" --enforce --watch 20 1.1.0 "$T/b.tgz"; rc=$?
is "exit 2" "$rc" 2
is "outcome rolled_back" "$(outcome "$R")" rolled_back
is "current is back on the old release" "$(current_of "$R")" 1.0.0
is "the app was restarted twice (install, rollback)" "$(wc -l < "$R/.restarts" | tr -d ' ')" 2
sleep 5   # the browser reloads a few seconds after the restart (FAKE_RELOAD_DELAY 3)
is "after rollback the old release reports healthy again" "$(grep -o '"screen":"[a-z]*"' "$T/b/ram/flairnode-render-health.json" | cut -d'"' -f4)" content
stop_unit "$R"

echo; echo "FROZEN VIDEO, ENFORCED -> ROLLS BACK"
R="$(make_unit c 1.0.0)"; make_tarball "$T/c.tgz" 1.1.0 frozen
install "$R" "$T/c/ram" --enforce --watch 20 1.1.0 "$T/c.tgz"; rc=$?
is "exit 2 (a video with no frames reaching the screen is not healthy)" "$rc" 2
is "current is back on the old release" "$(current_of "$R")" 1.0.0
stop_unit "$R"

echo; echo "SILENT APP, ENFORCED -> ROLLS BACK"
R="$(make_unit d 1.0.0)"; make_tarball "$T/d.tgz" 1.1.0 none
install "$R" "$T/d/ram" --enforce --watch 10 1.1.0 "$T/d.tgz"; rc=$?
is "exit 2 (no report at all is a failure, not a pass)" "$rc" 2
is "current is back on the old release" "$(current_of "$R")" 1.0.0
stop_unit "$R"

echo; echo "ERROR SCREEN, OBSERVE MODE (the default) -> KEEPS, RECORDS"
R="$(make_unit e 1.0.0)"; make_tarball "$T/e.tgz" 1.1.0 error
install "$R" "$T/e/ram" --watch 10 1.1.0 "$T/e.tgz"; rc=$?
is "exit 0" "$rc" 0
is "outcome would_roll_back" "$(outcome "$R")" would_roll_back
is "the new release is kept" "$(current_of "$R")" 1.1.0
stop_unit "$R"

echo; echo "BENCH OPT-OUT FILE BEATS --enforce"
R="$(make_unit f 1.0.0)"; make_tarball "$T/f.tgz" 1.1.0 error; touch "$R/shared/.no-health-rollback"
install "$R" "$T/f/ram" --enforce --watch 10 1.1.0 "$T/f.tgz"; rc=$?
is "outcome would_roll_back" "$(outcome "$R")" would_roll_back
is "the new release is kept" "$(current_of "$R")" 1.1.0
stop_unit "$R"

echo; echo "UNLINKED NODE SHOWING ITS SERIAL -> HEALTHY"
R="$(make_unit g 1.0.0)"; make_tarball "$T/g.tgz" 1.1.0 serial
install "$R" "$T/g/ram" --enforce --watch 20 1.1.0 "$T/g.tgz"; rc=$?
is "outcome ok (no wall assigned is not a failure)" "$(outcome "$R")" ok
stop_unit "$R"

echo; echo "WRONG VERSION INSIDE THE TARBALL -> REFUSED BEFORE ANYTHING MOVES"
R="$(make_unit h 1.0.0)"; make_tarball "$T/h.tgz" 1.1.0 good 1.0.9
install "$R" "$T/h/ram" --enforce --watch 10 1.1.0 "$T/h.tgz"; rc=$?
is "exit 1" "$rc" 1
is "current untouched" "$(current_of "$R")" 1.0.0
is "app never restarted" "$([ -f "$R/.restarts" ] && echo restarted || echo no)" no
is "nothing left in releases/ but the live one" "$(ls -A "$R/releases" | tr '\n' ' ')" "1.0.0 "

echo; echo "FLAT LAYOUT -> REFUSED"
mkdir -p "$T/i/flairnode"
install "$T/i/flairnode" "$T/i" --watch 10 1.1.0 "$T/a.tgz"; rc=$?
is "exit 10" "$rc" 10

echo; echo "ALREADY ON THE TARGET -> NOTHING TOUCHED"
R="$(make_unit j 1.1.0)"
install "$R" "$T/j/ram" --enforce --watch 10 1.1.0 "$T/a.tgz"; rc=$?
is "exit 0" "$rc" 0
is "outcome already_current" "$(outcome "$R")" already_current
is "app never restarted" "$([ -f "$R/.restarts" ] && echo restarted || echo no)" no

echo; echo "LIVE FOLDER NAMED THE TARGET BUT SAYS OTHERWISE -> REFUSED, NOT DELETED"
R="$(make_unit k 1.1.0)"; printf '1.0.5\n' > "$R/releases/1.1.0/VERSION"
install "$R" "$T/k/ram" --enforce --watch 10 1.1.0 "$T/a.tgz"; rc=$?
is "exit 1" "$rc" 1
is "the live release is still there" "$(cat "$R/releases/1.1.0/VERSION" 2>/dev/null)" 1.0.5

echo; echo "SECOND INSTALL WHILE ONE RUNS -> REFUSED"
R="$(make_unit l 1.0.0)"
exec 8>"$R/.install.lock"; flock -n 8
install "$R" "$T/l/ram" --enforce --watch 10 1.1.0 "$T/a.tgz"; rc=$?
exec 8>&-
is "exit 11" "$rc" 11

echo; echo "OLD RELEASES PRUNED TO TWO AFTER A PASS"
R="$(make_unit m 1.0.0)"; make_release_dir "$R/releases/0.9.0" 0.9.0 good; make_release_dir "$R/releases/0.8.0" 0.8.0 good
install "$R" "$T/m/ram" --enforce --watch 20 1.1.0 "$T/a.tgz"
is "only current and previous remain" "$(ls -1 "$R/releases" | tr '\n' ' ')" "1.0.0 1.1.0 "
stop_unit "$R"

echo; echo "DETACHED: THE CALLER RETURNS AT ONCE, THE INSTALL FINISHES WITHOUT IT"
R="$(make_unit n 1.0.0)"; make_tarball "$T/n.tgz" 1.1.0 error
start=$(date +%s)
out="$(FLAIR_NO_SYSTEMD=1 FLAIR_ROOT="$R" FLAIR_RAM_DIR="$T/n/ram" \
       FLAIR_RESTART_CMD="$T/fake-restart.sh $R $T/n/ram" FLAIR_GRACE_SECONDS=4 FLAIR_POLL_SECONDS=1 \
       bash "$INSTALLER" --enforce --watch 12 1.1.0 "$T/n.tgz")"
took=$(( $(date +%s) - start ))
is "caller got STARTED back" "$(echo "$out" | grep -c STARTED)" 1
is "caller returned in under 3 s (the watch alone is 12 s)" "$([ $took -lt 3 ] && echo yes || echo "no, ${took}s")" yes
is "no outcome yet at that moment" "$(outcome "$R")" ""
for _ in $(seq 1 30); do [ -n "$(outcome "$R")" ] && break; sleep 1; done
is "the detached run finished on its own and rolled back" "$(outcome "$R")" rolled_back
is "current is back on the old release" "$(current_of "$R")" 1.0.0
is "every run is appended to the event log" "$(wc -l < "$R/shared/state/install-events.log" | tr -d ' ')" 1
stop_unit "$R"

# ---------------------------------------------------------------- done

for p in "$T"/*/flairnode "$T"/i/flairnode; do stop_unit "$p"; done
pkill -f "fake-app.sh $T" 2>/dev/null
rm -rf "$T"

echo; echo "$pass passed, $fail failed."
[ "$fail" -eq 0 ]
