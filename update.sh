#!/usr/bin/env bash
#
# FlairNode updater — v2 (2026-08-19)
#
# WHAT CHANGED FROM v1 AND WHY
#
# v1 was 25 lines with no error checking and an unconditional success message
# at the end. Combined with MacrosModule scraping the second-to-last stdout
# line as "the result", every device reported
#   "Flair Node update.sh script v071625 complete!"
# on every update, whether or not a single byte was installed. A rate-limited
# GitHub archive endpoint returns 404; curl without --fail writes the error
# page into the zip and exits 0; unzip fails; rsync copies nothing; the echo
# fires; the flag clears; the cloud shows success. Silent, green, wrong.
#
# v2 does NOT change the on-disk layout. It only makes the script honest:
# it fails loudly, it validates before touching the live tree, and its final
# line describes what actually happened. The release-directory/symlink
# rollback design is deliberately NOT here — see "DELIBERATELY NOT IN v2".
#
# EXIT CODES (consumed by MacrosModule)
#   0  installed, or nothing to do, or a harmless lock collision
#   1  aborted before the live tree was touched
#   2  reserved for "rolled back" — unused in v2, do not repurpose
#
# DELIBERATELY NOT IN v2, each for a stated reason:
#
#   * No signal trap. MacrosModule still launches this script with exec(),
#     making it a CHILD of FlairNode.js, and PM2 defaults to treekill:true.
#     A trap here would fire when the app is restarted and could roll back a
#     good install — this is exactly the bug that froze ~93 Attitude devices
#     for weeks. DO NOT ADD A TRAP until MacrosModule uses a detached spawn.
#
#   * No rsync --delete. Files removed from the repo therefore linger on
#     devices forever, which is real drift. It is not fixed here because
#     --delete against the live tree needs an exclude list covering id.json,
#     config.json, content/, logs and browser profiles, and one wrong entry
#     wipes a device's identity with no shell to recover it. Non-destructive
#     drift beats a recoverable-only-by-van mistake. The release-directory
#     design in v3 solves this correctly and for free.
#
#   * No version/idempotence check. There is no VERSION file yet. Once one
#     exists, compare it to the target here and exit 0 early when they match.
#
#   * No rollback. There is no snapshot to roll back to without the release
#     directory layout. v3.
#
# NOTE ON SELF-REPLACEMENT: rsync writes to a temporary file and renames, so
# replacing this script while it runs gives the new file a new inode and the
# executing bash keeps reading the old one. This is safe ONLY because of that
# default. Never add --inplace to the rsync below.

set -euo pipefail

# Run from this script's own directory, not the caller's. MacrosModule
# happens to exec() us with the right cwd today; do not depend on it.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- configuration -----------------------------------------------------------
# Overridable for bench testing and canarying: point one unit at a branch
# without touching main. Production callers set neither.
REPO_URL="${FLAIR_REPO_URL:-https://github.com/J2-John/flairnode}"
REF="${FLAIR_REF:-main}"

ZIP_FILE="flairnode.zip"
TMP_DIR="flairnode_tmp"
RSYNC_LOG="update-last.log"
# UNZIPPED_DIR is DISCOVERED after extraction, not constructed. GitHub names the
# top-level folder "<repo>-<ref>" with slashes replaced by dashes, so building it
# from $REF silently breaks for any branch containing a slash — exactly the refs
# used for canarying (scratch/foo -> flairnode-scratch-foo).
UNZIPPED_DIR=""

# Files that must exist in the downloaded tree before we touch anything live.
REQUIRED_FILES=("FlairNode.js" "package.json" "render.html")

# --- helpers -----------------------------------------------------------------
# Diagnostics go to stderr; only the final summary goes to stdout. MacrosModule
# reads the LAST stdout line as the result, and exec() has a ~1MB maxBuffer that
# rsync's per-file output would blow straight through on a tree containing
# node_modules — which would report a SUCCESSFUL update as a failure.
say()  { echo "[update] $*" >&2; }
die()  { echo "[update] ABORT: $*" >&2; echo "UPDATE ABORTED: $*"; exit 1; }

cleanup_tmp() { rm -rf "$ZIP_FILE" "$TMP_DIR"; }

# --- single-instance guard ---------------------------------------------------
# A concurrent run rsyncing the same tree would interleave writes. MacrosModule's
# 5-minute guard does not cover a manual run racing a triggered one.
# A collision exits 0 on purpose: it is harmless, and reporting it as a failure
# would make the server re-arm the trigger and loop.
LOCKFILE=".update.lock"
if command -v flock >/dev/null 2>&1; then
        exec 9>"$LOCKFILE"
        if ! flock -n 9; then
                say "another update is already running - exiting without action"
                echo "UPDATE SKIPPED: another update already in progress"
                exit 0
        fi
else
        say "WARNING: flock not installed - running without the single-instance guard"
fi

# --- download ----------------------------------------------------------------
URL="$REPO_URL/archive/refs/heads/$REF.zip"
say "downloading $URL"

cleanup_tmp

# --fail          turn an HTTP 404/429 into a non-zero exit instead of a saved
#                 error page. GitHub rate-limits the archive endpoint and
#                 returns 404, and multiple nodes at one site share a public IP.
# --retry         transient failures only; --fail-early keeps a real 404 from
#                 burning all four attempts.
if ! curl --fail --location --silent --show-error \
          --retry 3 --retry-delay 10 --retry-connrefused \
          --connect-timeout 30 --max-time 600 \
          -o "$ZIP_FILE" "$URL"; then
        die "download failed (rate limit, network, or bad ref '$REF')"
fi

[ -s "$ZIP_FILE" ] || die "downloaded archive is empty"

# --- validate BEFORE touching anything live ----------------------------------
say "verifying archive integrity"
unzip -tq "$ZIP_FILE" >/dev/null 2>&1 || die "archive is not a valid zip (likely an HTML error page)"

say "extracting"
unzip -q "$ZIP_FILE" -d "$TMP_DIR" || die "extraction failed"

UNZIPPED_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -n "$UNZIPPED_DIR" ] || die "archive contained no top-level directory"
[ -d "$UNZIPPED_DIR" ] || die "extracted path $UNZIPPED_DIR is not a directory"
say "extracted to $UNZIPPED_DIR"

for f in "${REQUIRED_FILES[@]}"; do
        [ -f "$UNZIPPED_DIR/$f" ] || die "downloaded tree is missing $f - refusing to install"
done

if [ ! -d "$UNZIPPED_DIR/node_modules" ]; then
        die "downloaded tree has no node_modules - refusing to install"
fi

say "validation passed"

# --- install -----------------------------------------------------------------
# Past this point the live tree is being modified. Everything above is safe to
# abort from; this is not.
say "installing over the live tree"

if ! rsync -a --itemize-changes "$UNZIPPED_DIR/" ./ > "$RSYNC_LOG" 2>&1; then
        # No rollback exists in v2. Say so plainly rather than implying recovery.
        say "rsync FAILED - the live tree may be partially updated"
        say "see $RSYNC_LOG"
        echo "UPDATE FAILED DURING INSTALL: live tree may be inconsistent, see $RSYNC_LOG"
        exit 1
fi

CHANGED="$(wc -l < "$RSYNC_LOG" | tr -d ' ')"

# Did this update replace THIS script? rsync writes a temp file and renames, so
# the running bash keeps reading the old inode and finishes normally — but the
# NEXT invocation is a different program. That is correct behaviour (updates
# should be able to update the updater) and it is completely silent, which is
# how it goes unnoticed. Announce it.
SELF=""
if grep -qE ' update\.sh$' "$RSYNC_LOG"; then
        SELF=" self-replaced=yes"
        say "NOTE: this update replaced update.sh itself - the next run is a different script"
fi

cleanup_tmp

# --- report ------------------------------------------------------------------
# This LAST stdout line is what MacrosModule reports to the cloud. It must
# describe what happened. It must never be a fixed string.
say "done - $CHANGED path(s) changed"
echo "UPDATE OK: ref=$REF changed=$CHANGED$SELF"
exit 0
