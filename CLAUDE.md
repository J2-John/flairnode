# CLAUDE.md

## Process Rules (non-negotiable)

- Never push to main without John's explicit approval. Workflow: investigate → propose → John approves → only then merge/push.
- Prose reports in the chat body for investigation results, not just diffs.
- On-device commands (Pi, droplet) are executed by John from his own terminal — never run directly against hardware; direct him with exact command sequences and expected observable results instead.

## Boot Architecture

Device identity is gated in three layers, enforced via `FlairNode.js`'s `whenReady()` event-driven startup (see `eventHub`'s `moduleReady` events):

`ProvisioningManager` → gates → `IdManager` → gates → everything else (`NetworkModule`, `PlaybackController`, `TriggerEngine`, etc.)

`ProvisioningManager.init()` checks whether `id.json` exists and parses to a valid `{device_id > 0, serialnumber}`. If not: pushes `CONNECTING...` to the display, reads `/proc/cpuinfo`'s `Serial` field, POSTs it to `${FLAIR_BASE_HOST}/api/v1/flair-node/provision`, writes the response to `id.json`, and pushes the returned serial number to the display. Retries every 60s on any failure (no internet on first boot is an accepted case, not an error). Only once this succeeds does `IdManager.init()` run — closes roadmap 17c: previously a missing/invalid `id.json` silently degraded `IdManager` to a fake `id=0` identity and let boot continue, so `NetworkModule`'s sync loop just 400'd forever with no explanation.

**id.json path resolution — fixed 2026-07-22 (commit 6f6bd3c).** `IdManager.mjs` exports `ID_JSON_PATH`, resolved as `path.dirname(fileURLToPath(import.meta.url))` + `'..'` + `id.json` — anchored to the module's own file location on disk, **not** `process.cwd()`. Resolves to `/home/pi/id.json` given the standard `~/flairnode/IdManager.mjs` layout, deliberately one directory *above* the app directory so a `git pull`/clean of `flairnode/` can never wipe device identity. This replaced the old `'../'` relative path, which was relative to whatever directory the process happened to be launched from and broke unless FlairNode was started with `cwd === ~/flairnode`. Treat the old cwd-relative behavior as resolved history, not a live risk — the fix is cwd-independent.

**The id=0 gotcha.** `device_id === 0` is `IdManager`'s own failover sentinel (used when `id.json` is missing/corrupt, outside `LAPTOP_MODE`). `ProvisioningManager`'s `idFileIsValid()` treats `device_id === 0` as invalid on purpose — a unit that somehow persisted `0` to disk needs re-provisioning, not a fast path into a guaranteed-400 sync loop.

## Reference Unit

- Pi: `pi@flairnode-staging` (hostname `flairnode-staging`), node_id 1, serial `FN-0000001`.
- Runs under pm2, process name `flairnode`. `pm2 startup` + `pm2 save` configured for systemd resurrection on boot.
- `FLAIR_BASE_HOST` env override is baked into this unit's saved pm2 process, pointed at the staging cloud. **Firmware default (no override) is production `https://flairled.com`** (`EnvironmentConfig.mjs`) — never assume a unit talks to staging without checking its pm2 env first.
- Kiosk (Chromium, `render.html`) auto-launches via XDG autostart (`flairnode-kiosk.sh`), independent of the pm2/FlairNode.js process — the two must both be running for the full identity-display flow to work.

## Roadmap 17c — Device Provisioning (Acceptance Log)

Verified on the reference Pi (real hardware, not `bench/provisioning-harness.mjs` simulation) on 2026-07-24:

- **Mint path — PASSED.** Run 1: `id.json` moved aside, reboot, `CONNECTING...` → `FN-00005` minted on staging with the correct `cpu_serial`, displayed correctly on glass.
- **Idempotent path — PASSED.** Run 2: after backfilling this Pi's real `cpu_serial` onto staging's node_id 1 record, device re-provisioned to its original `FN-0000001` identity; `id.json` written correctly with all three fields.
- **Sync freshness — CONFIRMED.** Staging `flair_nodes` record 1: `last_ping = 2026-07-24T15:15:18Z`, seconds after re-provisioning, status 2 / green / "Connected" (`find(1)->toArray()` on staging). Note: the real column is `last_ping`, not `lastping` — an earlier query against the wrong field name produced phantom nulls.

Merged to `main` 2026-07-24 on John's explicit approval, with the three findings below ledgered as follow-ups (none were blockers for this branch).

## Recurring Gotchas / Follow-ups

- **Display-state race, restart flow only (not reboot).** On `pm2 restart` with the kiosk already connected, provisioning can succeed while the glass stays stuck on `CONNECTING...`. `ProvisioningManager.mjs`'s `pushDisplay()` sends are fire-and-forget (`RenderSocketClient.send()` silently drops if no client is connected at that instant) — the only delivery guarantee is the one-shot `renderClientConnected` → 1s-delay resend of whatever `lastDisplayText` currently is. A `pm2 restart` kills the old WS server; the kiosk's own reconnect (`render.html`, `reconnectInterval` = 1000ms) plus that 1s resend delay creates a ~2s dead window after restart where display commands can land outside any delivery path. Doesn't reproduce on a full reboot (no live kiosk connection to race against). Not fixed. Next diagnostic: correlate `pm2 logs flairnode` timestamps of `Render client connected!!` vs `Provisioned successfully as...` across a reproduction to pin the exact ordering before attempting a fix.

- **UDPManager EBADF error-log spam — pre-existing, not caused by 17c.** `UDPManager.mjs` has zero code changes in the 17c branch (confirmed via diff) — the `bind()` callback calling `this.socket.setBroadcast(true)` outside the enclosing `try/catch`'s effective stack frame has been in place since the 2026-07-01 `whenReady()` refactor (commit e811721). 17c only changed *when* `UDPManager.init()` fires in the boot sequence (later, gated behind provisioning succeeding), not its internals. Most likely exposed by 17c's test procedure doing several back-to-back `pm2 restart` cycles in quick succession (mint run, then idempotent run) — normal single-boot production operation restarts far less often. Not fixed; not a 17c blocker.

- **Serial format: 5-digit (`FN-00005`) is canonical — `FN-0000001` is a legacy exception, not a defect.** Corrects an earlier entry here that assumed the mixed widths needed normalizing. John ruled 2026-07-24: the 5-digit zero-padded format (`FN-XXXXX`), as generated by `FlairNodeController::provision()`, is the standing convention — not a bug. `FN-0000001` (Reference Pi 5, node_id 1) is a legacy, hand-created serial pre-dating that convention, ledgered as such and deliberately not renamed to match. See `flairled`'s `CLAUDE.md` (commit 3ebf0c3) for the cloud-side record of this ruling. `flairnode` still has no serial-formatting code anywhere (grep finding stands — `writeIdFile()`/`pushDisplay()` pass `serial_number` through verbatim from the cloud's `/provision` response), and that remains correct: there is no formatting for it to do. No action pending anywhere, on either repo.

- **Hostname renames invalidate Chromium's SingletonLock — fixed on FN-00006 bring-up.** Chromium's profile dir (`~/.flair-chrome-test`) keeps a `SingletonLock` (and related `Singleton*` files) tying the profile to the machine's hostname. It survives a reboot on disk, and the 17c provisioning flow's mid-setup hostname rename means a unit can boot with a *different* hostname than the one the lock was written under — Chromium then reads its own leftover lock as "profile in use on another computer" and refuses to launch at all, leaving a silent desktop instead of the kiosk. `flairnode-kiosk.sh` now runs `rm -f "$HOME/.flair-chrome-test/Singleton"*` immediately before every `chromium` launch. Safe by construction, not just in this one case: that profile directory is dedicated to a single kiosk Chromium instance per unit, so any lock file present at script start is necessarily stale (either a fresh boot or a prior unclean exit) — there is no scenario where a second live Chromium is legitimately holding it.

- **Security code (claim PIN) shown on glass while unlinked — fixed on FN-00006 bring-up.** The auto-generated `security_code` was written to `id.json` by `ProvisioningManager` but surfaced to no human — the old manual runbook always had a person typing `id.json` by hand who knew it; the automatic flow didn't. `IdManager.getSecurityCode()` now exposes it, and it rides alongside the serial number on the identity display whenever the node is unlinked: `PlaybackController`'s `!wallType` fallback (the durable path, re-evaluated every playback cycle) and `ProvisioningManager`'s post-mint push (immediate first-boot feedback) both send it. It vanishes automatically the moment the cloud assigns `wall_type` (the existing linked-vs-unlinked signal) and that fallback branch stops running — no separate "hide on link" check needed. `null` is expected and tolerated for legacy hand-provisioned units, which never had this field.
