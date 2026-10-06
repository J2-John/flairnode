// TriggerEngine.mjs
// device-side trigger engine for the Flair Node firmware (roadmap 29b, phase 3)
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the TriggerEngine javascript object,
// which owns all trigger STATE and DECISION logic: edge detection on Sense port
// data, per-port fire/expiry timing, visibility resolution (priority + cap —
// overlapping triggers STACK, there is no conflict/overlap check), and the CPU
// load governor. It never touches UDPManager, RenderSocketClient,
// or the render client directly — PlaybackController already owns the validated/
// paired Sense packet pipeline (handleNewSenseData) and the render-client
// transport (safeSend), so this module is fed a pre-validated port-state array by
// PlaybackController and talks back to it ONLY via eventHub ('triggerShow' /
// 'triggerHide'). That keeps this a one-way dependency (PlaybackController ->
// TriggerEngine) with no import cycle: TriggerEngine never imports
// PlaybackController.


// import modules
import os from 'os';
import eventHub from './EventHub.mjs';
import configManager from './ConfigManager.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('TriggerEngine');



// ==================== CONSTANTS ====================

// Locked ruleset (roadmap 29b phase 3): recompute visibility on every
// fire/expiry, and (implicitly, this module's own extension) on every
// governor cap change too — a cap change without a recompute would leave
// stale visibility standing.
const EXPIRY_CHECK_INTERVAL_MS = 1000;  // how often to sweep for expired triggers

// ---- Load governor ----
// CPU_LOAD_THRESHOLD_HIGH/LOW were calibrated July 11, 2026 at 256x256
// bench scale (Pi 5, 4 cores, base video + 4 trigger streams): loadavg[0]
// peaked at 0.83 of 4.0 — massive headroom at bench scale. The thresholds
// below are NOT tuned to that measured peak; they're set well above it
// (~75%/~50% of core count) as a safety margin. The governor is expected
// to be INERT in normal operation at this wall scale. If it activates
// routinely on a larger wall (more zones, higher resolution, more
// concurrent triggers), recalibrate against THAT wall class specifically —
// don't just raise these numbers blindly, since that would mask a real
// capacity problem on the wall that actually tripped it.
//
// Saturation is derived from the actual core count (os.cpus().length)
// rather than an assumed number, so this tracks correctly if the fleet
// ever runs on hardware with a different core count than this Pi 5.
//
// CPU_SAMPLE_INTERVAL_MS, CPU_SUSTAINED_SAMPLES_REQUIRED, and the
// VISIBLE_CAP_* values were NOT part of this calibration pass — still
// placeholder values, calibrate in phase 4 bench testing.
//
// "Visible" in this engine means accepted-and-rendered, not necessarily
// seen. Overlapping triggers stack (no conflict/overlap check), so an
// accepted trigger can be fully covered on screen by another accepted
// trigger stacked above it (e.g. a full-canvas trigger on a higher port)
// — it is still actively decoding and rendering underneath, consuming a
// real decode stream, even though nothing of it is visible on the wall.
// The engine does not attempt to detect or optimize away that visual
// redundancy; VISIBLE_CAP is the deliberate budget on how many concurrent
// decode streams this device carries, independent of whether every one
// of them is actually contributing pixels.
const CPU_CORE_COUNT = os.cpus().length;                // e.g. 4 on Pi 5 — drives the thresholds below
const CPU_SAMPLE_INTERVAL_MS = 5000;                     // calibrate in phase 4 bench testing
const CPU_LOAD_THRESHOLD_HIGH = CPU_CORE_COUNT * 0.75;   // calibrated July 11, 2026 @ 256x256 bench scale
const CPU_LOAD_THRESHOLD_LOW = CPU_CORE_COUNT * 0.50;    // calibrated July 11, 2026 @ 256x256 bench scale
const CPU_SUSTAINED_SAMPLES_REQUIRED = 3;                // calibrate in phase 4 bench testing — consecutive samples before acting
const VISIBLE_CAP_DEFAULT = 4;                           // calibrate in phase 4 bench testing
const VISIBLE_CAP_FLOOR = 1;
const VISIBLE_CAP_CEILING = 4;



// ==================== CLASS DEFINITION ====================
class TriggerEngine {

	// constructor
	constructor() {
		// per-port state for ports with a currently-active (unexpired) fire:
		// { [port]: { sceneId, firedAt, expiresAt } }. A port with no entry
		// has never fired, or its last fire has already expired.
		this.portState = {};

		// the set of ports currently ACCEPTED as visible — a subset of
		// Object.keys(this.portState), the top currentVisibleCap ports by
		// port number descending. Everything active-but-not-in-this-set was
		// shed by the cap/governor, and stays hidden (no video asserted)
		// but keeps counting down. Overlapping triggers stack — there is no
		// other way for an active trigger to be excluded from this set.
		this.visiblePorts = new Set();

		// Monotonic fire counter, for ordering exclusive evictions.
		//
		// NOT A TIMESTAMP, and that is the point. firedAt is milliseconds, and
		// two ports can rise in the SAME packet or in two packets processed
		// inside the same millisecond — which makes firedAt tie, makes a
		// stable sort fall back to Object.keys() order, and hands the glass to
		// the LOWER-numbered port, i.e. the one that did NOT just fire. Caught
		// by the harness on 2026-10-05 with seven red checks; it would have
		// worked on a bench where packets arrive 100 ms apart and failed in the
		// field whenever two inputs closed together. A counter cannot tie.
		this.fireSequence = 0;

		// last-seen 19-element Sense port array, for inactive->active edge
		// detection. null until the first packet arrives — the very first
		// packet only establishes a baseline (see processSenseData), since
		// there's no prior state to compare an already-active port against.
		this.previousSenseData = null;

		// load governor state
		this.currentVisibleCap = VISIBLE_CAP_DEFAULT;
		this.highLoadStreak = 0;
		this.lowLoadStreak = 0;

		this.expiryInterval = null;
		this.loadSampleInterval = null;
	}


	// initialization function
	init() {
		this.expiryInterval = setInterval(() => {
			this.checkExpiries();
		}, EXPIRY_CHECK_INTERVAL_MS);

		this.loadSampleInterval = setInterval(() => {
			this.sampleLoad();
		}, CPU_SAMPLE_INTERVAL_MS);

		// a sync cycle can change a port's trigger assignment (reassigned
		// scene_id, cleared slot, changed duration_seconds) while that port
		// is actively counting down. configManager.update() has already
		// applied the new data by the time this fires (NetworkModule calls
		// it synchronously before emitting), so getTriggers() below reads
		// the new config, not the one this port fired against.
		eventHub.on('newNetworkDataProcessed', () => {
			this.reconcileTriggerConfig();
		});

		logger.info('Initializing Trigger Engine...');

		eventHub.emit('moduleStatus', {
			name: 'TriggerEngine',
			status: 'operational',
			data: '',
		});

		// signal that this module has finished initializing
		eventHub.emit('moduleReady', 'TriggerEngine');
	}


	// ==================== FIRE (edge detection) ====================

	// processSenseData - entry point called by PlaybackController with an
	// ALREADY validated + paired 19-element array of 0/1 values (see
	// UDPManager.validateIncomingPacket + PlaybackController.
	// validateSenseDataObject / the assignedSenseSerial pairing guard —
	// this method trusts its input completely rather than re-checking any
	// of that, by design: don't reimplement the guard, build on it).
	processSenseData(dataArray) {
		try {
			// first-ever packet: nothing to compare against yet, so treat
			// every port as "already was whatever it currently is" — an
			// already-active port on boot must NOT be treated as a fresh
			// edge (that would fire every trigger on every device restart
			// while a port happened to be held active).
			if (!this.previousSenseData) {
				this.previousSenseData = dataArray;
				return;
			}

			const now = Date.now();

			// anyChanged, not anyFired: switch-mode ports can now LEAVE
			// portState on a falling edge, and a removal needs the same
			// resolveVisibility() recompute a fire does. Naming it for firing
			// alone is what would let a removal skip the recompute and leave a
			// hidden-but-still-shown scene on the glass.
			let anyChanged = false;

			for (let i = 0; i < dataArray.length; i++) {
				const port = i + 1;
				const isActive = dataArray[i] === 1;
				const wasActive = this.previousSenseData[i] === 1;

				// FIRE only on the inactive->active edge — holding active
				// across packets is not a re-fire (locked ruleset §2). This is
				// identical for both modes; mode only changes what happens
				// while held and on release.
				if (isActive && !wasActive) {
					if (this.fireTrigger(port, now)) {
						anyChanged = true;
					}
				} else if (isActive) {
					// HELD HIGH (active this packet and the last one). A pulse
					// port ignores this entirely and runs out its own clock —
					// unchanged from before. A switch port instead has its
					// window pushed forward so it stays alive, and keeps
					// looping, for as long as the contact is closed.
					//
					// Deliberately does NOT set anyChanged: the set of active
					// ports is identical, so there is nothing for
					// resolveVisibility() to recompute, and calling it here
					// would re-show the scene on every packet (locked ruleset
					// §2's "holding active is not a re-fire" applies to the
					// visible effect too, not just to fireTrigger).
					const state = this.portState[port];

					if (state && state.mode === 'switch') {
						state.expiresAt = now + state.durationMs;
					}
				} else if (wasActive) {
					// FALLING EDGE (contact opened). Pulse ignores this and
					// expires on its own schedule via checkExpiries() — again
					// unchanged. Switch ends immediately: drop the port's state
					// and flag the recompute so resolveVisibility() hides it.
					const state = this.portState[port];

					if (state && state.mode === 'switch') {
						delete this.portState[port];
						anyChanged = true;

						logger.info(`Trigger port ${port} released (switch) -> ended`);
					}
				}
			}

			this.previousSenseData = dataArray;

			if (anyChanged) {
				this.resolveVisibility();
			}
		} catch (error) {
			logger.error(`Error processing sense data in TriggerEngine: ${error.message}`);
		}
	}


	// fireTrigger - records/restarts a port's countdown. Returns true if a
	// real fire happened (a scene was actually assigned+valid), false if
	// this port has no assignable trigger (nothing to log/recompute for).
	fireTrigger(port, now) {
		const triggerConfig = configManager.getTriggers()?.find(t => t.port === port);

		if (!triggerConfig || triggerConfig.scene_id == null) {
			return false;  // no scene assigned to this port
		}

		const durationSeconds = triggerConfig.duration_seconds;

		if (!(durationSeconds >= 1)) {
			// cloud-side validation (RoleController::update()) should make
			// this unreachable for anything saved through the GUI, but a
			// device is fed whatever sync() delivers — never trust that
			// alone either.
			logger.warn(`Trigger port ${port} fired but has no valid duration_seconds — ignoring.`);
			return false;
		}

		const isReFire = !!this.portState[port];

		// Per-trigger mode. ABSENT MEANS PULSE, deliberately: a config synced
		// from a cloud that has never heard of this field must behave exactly
		// as it did before the field existed. Anything that isn't the literal
		// string 'switch' or 'exclusive' is pulse — this never guesses from a
		// truthy value.
		//
		// pulse:  fire on the rising edge, run for duration_seconds, expire on
		//         its own. The contact opening again means nothing.
		// switch: fire on the rising edge, then stay alive for as long as the
		//         contact is held closed (processSenseData pushes expiresAt
		//         forward on every held-high packet), and end the moment it
		//         opens. durationMs is carried here so that refresh has the
		//         window length without re-reading config on every packet.
		// exclusive: fire on the rising edge like pulse, but CLEAR every other
		//         visible pulse-family trigger (resolveVisibility does the
		//         evicting), and play the clip ONCE at its own length rather
		//         than looping for duration_seconds. John's ruling 2026-10-05;
		//         see claude/trigger-mode-exclusive-spec.md.
		//
		// NOTE FOR A NODE ON OLDER FIRMWARE: 'exclusive' collapses to pulse
		// here, silently, while the role editor still shows Exclusive
		// selected. Check the firmware version before diagnosing "Exclusive
		// isn't working".
		const mode = triggerConfig.mode === 'switch' ? 'switch'
			: triggerConfig.mode === 'exclusive' ? 'exclusive'
			: 'pulse';

		// EXCLUSIVE TAKES ITS WINDOW FROM THE CLIP, NOT THE CONFIG (E5). The
		// scene's own length is already in the sync payload as
		// total_length_seconds and had simply never been read by the firmware
		// — no cloud change was needed for this.
		//
		// Falls back to duration_seconds when that is missing, zero or not a
		// number (E6): an old or part-rendered scene must still fire. A
		// trigger that refuses to fire is worse than one that runs for the
		// wrong length, and the fallback says so in the log rather than
		// looking like a correct window.
		let durationMs = durationSeconds * 1000;
		let windowSource = 'duration_seconds';

		if (mode === 'exclusive') {
			const scene = configManager.getScenes()?.find(s => s.id === triggerConfig.scene_id);
			const clipSeconds = Number(scene?.total_length_seconds);

			if (Number.isFinite(clipSeconds) && clipSeconds > 0) {
				durationMs = clipSeconds * 1000;
				windowSource = 'total_length_seconds';
			} else {
				logger.warn(`Trigger port ${port} is exclusive but scene ${triggerConfig.scene_id} has no usable total_length_seconds (${scene?.total_length_seconds}) — falling back to duration_seconds (${durationSeconds}s).`);
			}
		}

		// Re-fire restarts the countdown (new expiresAt) whether currently
		// visible or hidden (locked ruleset §3) — a plain overwrite already
		// gives us exactly that, visible or not.
		this.portState[port] = {
			sceneId: triggerConfig.scene_id,
			firedAt: now,
			// Strictly increasing, never equal. See the constructor for why a
			// timestamp will not do here.
			firedSeq: ++this.fireSequence,
			expiresAt: now + durationMs,
			mode,
			durationMs,
			// Exclusive plays its clip through once; every other mode loops
			// for its window as before. Carried on the state because
			// showTrigger() is what hands it to PlaybackController, and that
			// can happen long after the fire (the governor can admit a port
			// it previously shed).
			repeat: mode !== 'exclusive',
			// A re-fire of a play-once trigger has to be put back on the glass
			// explicitly — see the reshow branch in resolveVisibility(). Set
			// ONLY for exclusive: a pulse re-fire must keep behaving exactly as
			// it did before this mode existed, and its clip is still looping on
			// screen anyway, so re-showing it would restart a video that never
			// stopped.
			reshow: isReFire && mode === 'exclusive',
		};

		logger.info(`Trigger port ${port} ${isReFire ? 're-fired' : 'fired'} (${mode}) -> scene ${triggerConfig.scene_id}, expires in ${Math.round(durationMs / 1000)}s (${windowSource})`);

		return true;
	}


	// ==================== EXPIRY ====================

	checkExpiries() {
		try {
			const now = Date.now();
			let anyExpired = false;

			for (const portKey of Object.keys(this.portState)) {
				const state = this.portState[portKey];

				if (state.expiresAt <= now) {
					logger.info(`Trigger port ${portKey} expired (scene ${state.sceneId})`);
					delete this.portState[portKey];
					anyExpired = true;
				}
			}

			if (anyExpired) {
				this.resolveVisibility();
			}
		} catch (error) {
			logger.error(`Error checking trigger expiries: ${error.message}`);
		}
	}


	// ==================== CONFIG RECONCILIATION ====================

	// reconcileTriggerConfig - a new sync can reassign, clear, or re-time
	// a port's trigger slot while that port is actively firing. Rule:
	//   - slot cleared (no config, or scene_id now null) -> kill the
	//     in-flight state and clear its video, same as a natural expiry.
	//   - slot reassigned to a DIFFERENT scene_id -> same: kill it. The
	//     currently-playing video belongs to the OLD assignment; nothing
	//     obligates it to keep counting down for a scene this port is no
	//     longer configured to show.
	//   - slot unchanged (same scene_id), including a changed
	//     duration_seconds -> leave the in-flight state untouched.
	//     duration_seconds is only read at fire time (see fireTrigger's
	//     expiresAt calculation) and never retroactively reapplied to an
	//     expiresAt already computed — a duration change takes effect on
	//     the NEXT fire, not the current one.
	// Reuses resolveVisibility()'s existing accept/reject + hide logic:
	// once a killed port's entry is gone from portState, it naturally
	// falls out of the accepted set, and if it was visible, the normal
	// "previously visible but no longer accepted" path emits triggerHide.
	reconcileTriggerConfig() {
		try {
			const triggers = configManager.getTriggers();
			let anyKilled = false;

			for (const portKey of Object.keys(this.portState)) {
				const port = Number(portKey);
				const state = this.portState[portKey];
				const newConfig = triggers?.find(t => t.port === port);

				const cleared = !newConfig || newConfig.scene_id == null;
				const reassigned = !cleared && newConfig.scene_id !== state.sceneId;

				if (cleared || reassigned) {
					logger.info(`Trigger port ${port} config changed (${cleared ? 'slot cleared' : `reassigned to scene ${newConfig.scene_id}`}) — killing in-flight state (was scene ${state.sceneId})`);
					delete this.portState[portKey];
					anyKilled = true;
				}
			}

			if (anyKilled) {
				this.resolveVisibility();
			}
		} catch (error) {
			logger.error(`Error reconciling trigger config: ${error.message}`);
		}
	}


	// ==================== VISIBILITY RESOLUTION ====================

	// resolveVisibility - recomputed from scratch on every fire, expiry,
	// AND governor cap change (recompute on every fire/expiry is the
	// locked ruleset; a cap change is this module's own necessary
	// extension of that same principle — leaving stale visibility standing
	// after the cap itself changed would defeat the governor).
	//
	// Product correction: overlapping triggers STACK — there is no
	// conflict/overlap check. Every active trigger is visible, up to
	// currentVisibleCap, selected by port descending (higher port = higher
	// priority = accepted first). Overlay metadata (overlay_x/y/width/
	// height) is NOT read here at all; it remains purely positioning data,
	// applied only when a video is actually asserted (see
	// PlaybackController.playSceneById). Z-order is still by port —
	// zIndexForPort()'s existing `-port` (cssZ = 100 + port in render.html)
	// already stacks higher ports above lower ones, so priority order and
	// on-screen stacking order are the same thing; nothing new was needed
	// there.
	resolveVisibility() {
		try {
			// EXCLUSIVE EVICTION, BEFORE the cap pass and deliberately ahead of
			// it (John's ruling 2026-10-05; claude/trigger-mode-exclusive-spec.md).
			//
			// Among pulse-family ports — 'pulse' and 'exclusive' — if any
			// EXCLUSIVE one is active, only the most recently fired survives
			// and the rest are dropped from portState entirely. Dropped, not
			// merely hidden: an evicted trigger is finished, not waiting for a
			// slot, so leaving it in portState would let the governor hand it
			// the glass back seconds later.
			//
			// SWITCH PORTS ARE NEVER TOUCHED HERE (E4). A switch is held closed
			// by physical hardware; if it lost the glass it would not return
			// until someone opened and closed that contact, so a closed input
			// would sit there showing nothing.
			//
			// A plain PULSE fire evicts nothing (E3) — this block only runs at
			// all when an exclusive port is present, which is what keeps every
			// existing site's behaviour identical after the update.
			const pulseFamily = Object.keys(this.portState)
				.map(Number)
				.filter(port => this.portState[port].mode !== 'switch');

			if (pulseFamily.length > 1) {
				// Most recent wins, by firedSeq — a strictly increasing counter,
				// NOT firedAt. Two ports rising in the same packet, or in two
				// packets handled inside the same millisecond, tie on a
				// timestamp; the stable sort then falls back to Object.keys()
				// order and the LOWER port wins, which is the one that did not
				// just fire. A counter cannot tie.
				const newest = pulseFamily
					.slice()
					.sort((a, b) => this.portState[b].firedSeq - this.portState[a].firedSeq)[0];

				// THE EVICTION IS DRIVEN BY WHAT FIRED MOST RECENTLY, not by an
				// exclusive merely being present (E3). An exclusive port that
				// fired earlier does not evict a pulse that fires after it —
				// only an exclusive arriving LAST clears the rest. Getting this
				// backwards is what the harness caught: the first version
				// evicted a running exclusive whenever any pulse fired.
				//
				// Written this way it is also idempotent, which matters because
				// resolveVisibility() is re-run by checkExpiries() and the load
				// governor as well as by a fire: if the newest is still the
				// exclusive, the others are already gone and this does nothing.
				if (this.portState[newest].mode === 'exclusive') {
					for (const port of pulseFamily) {
						if (port !== newest) {
							logger.info(`Trigger port ${port} evicted by exclusive port ${newest}`);
							delete this.portState[port];
						}
					}
				}
			}

			// ----- unchanged from here down -----
			// The cap and port-priority pass is deliberately untouched, so the
			// load governor stays authoritative: under load it can still shed
			// an exclusive port in favour of a higher-numbered one. A mode
			// preference must not override a safety valve.
			const activePorts = Object.keys(this.portState)
				.map(Number)
				.sort((a, b) => b - a);  // descending: higher port = higher priority

			const accepted = activePorts.slice(0, this.currentVisibleCap);
			const acceptedSet = new Set(accepted);
			const previouslyVisible = this.visiblePorts;

			// newly visible -> show
			for (const port of accepted) {
				const state = this.portState[port];

				if (!previouslyVisible.has(port)) {
					this.showTrigger(port);
				} else if (state.reshow) {
					// A RE-FIRE OF A PLAY-ONCE TRIGGER. Reported from the bench
					// 2026-10-06 as "a second trigger will not play", and
					// reproduced: tripping an Exclusive port again inside its own
					// window put nothing on the glass.
					//
					// Why it needs its own branch: render.html's renderVideoFile
					// attaches an 'ended' listener to a non-looping clip that
					// REMOVES the element. So when a play-once clip finishes there
					// is nothing on screen, while this engine still counts the port
					// as visible until expiresAt — and showTrigger() above only
					// runs for a port that is not already visible. For a LOOPING
					// trigger "visible" and "showing" were the same thing, so
					// restarting the countdown was enough. Play-once separated
					// them and the old assumption no longer holds.
					//
					// Hide THEN show, rather than show alone, because
					// assertVideoIsPlaying() returns early on a healthy video: a
					// re-trip while the clip is still running would otherwise let
					// it carry on from where it was instead of starting again,
					// which is not what "cut it off and put this one in its place"
					// means.
					this.hideTrigger(port);
					this.showTrigger(port);
				}

				if (state.reshow) {
					delete state.reshow;
				}
			}

			// no longer accepted (expired OR shed by the cap/governor) -> hide
			for (const port of previouslyVisible) {
				if (!acceptedSet.has(port)) {
					this.hideTrigger(port);
				}
			}

			this.visiblePorts = acceptedSet;
		} catch (error) {
			logger.error(`Error resolving trigger visibility: ${error.message}`);
		}
	}


	// ==================== PLAYBACK (via eventHub — see file header) ====================

	showTrigger(port) {
		const state = this.portState[port];
		if (!state) return;

		eventHub.emit('triggerShow', {
			port,
			sceneId: state.sceneId,
			domId: this.domIdForPort(port),
			zIndex: this.zIndexForPort(port),
			// Exclusive plays once; everything else loops for its window.
			// Read off the state rather than recomputed, because a port can
			// become visible long after it fired (the governor can admit one
			// it previously shed) and the mode must not be re-derived from a
			// config that may have changed in between.
			repeat: state.repeat !== false,
		});

		logger.info(`Trigger port ${port} now VISIBLE -> scene ${state.sceneId}`);
	}

	hideTrigger(port) {
		eventHub.emit('triggerHide', {
			port,
			domId: this.domIdForPort(port),
		});

		logger.info(`Trigger port ${port} now HIDDEN`);
	}

	// domIdForPort - PORT-scoped, deliberately NOT scene-id-scoped. Two
	// different ports assigned the same scene_id must still be two
	// independent DOM elements (independently visible/hidden/expired);
	// scene-id-scoped dom_ids (like the base video's own scheme) would
	// collide in that case.
	domIdForPort(port) {
		return `trigger-port-${port}`;
	}

	// zIndexForPort - "logical z" in the same units playSceneById()'s
	// z_index param already uses (render.html converts via
	// cssZIndex = 100 - logicalZ). Base video's default logicalZ is 17
	// (cssZ 83); triggers must always render above that AND stack by port
	// (locked ruleset §6), so logicalZ = -port gives cssZ = 100+port for
	// ports 1-19 (cssZ 101-119) — comfortably above the base, monotonic
	// with port, never colliding with the offline indicator (cssZ 99999).
	zIndexForPort(port) {
		return -port;
	}

	// getVisibleDomIds - PlaybackController reads this when clearing the
	// screen for a base-scene change, so a base rotation never wipes an
	// actively-visible trigger out from under this engine (see
	// PlaybackController.playSceneById's clearElse branch).
	getVisibleDomIds() {
		return Array.from(this.visiblePorts).map(port => this.domIdForPort(port));
	}


	// ==================== LOAD GOVERNOR ====================

	// sampleLoad - "sustained" is implemented as N consecutive samples past
	// a threshold, reset the moment a sample falls in the dead zone between
	// the two thresholds (or the opposite direction) — a single spike or
	// dip can't move the cap on its own.
	sampleLoad() {
		try {
			const load1 = os.loadavg()[0];

			if (load1 >= CPU_LOAD_THRESHOLD_HIGH) {
				this.highLoadStreak++;
				this.lowLoadStreak = 0;
			} else if (load1 <= CPU_LOAD_THRESHOLD_LOW) {
				this.lowLoadStreak++;
				this.highLoadStreak = 0;
			} else {
				this.highLoadStreak = 0;
				this.lowLoadStreak = 0;
			}

			if (this.highLoadStreak >= CPU_SUSTAINED_SAMPLES_REQUIRED && this.currentVisibleCap > VISIBLE_CAP_FLOOR) {
				this.currentVisibleCap -= 1;
				this.highLoadStreak = 0;  // require a fresh sustained streak before shedding again

				logger.warn(`Load governor: sustained high load (${load1.toFixed(2)}) — VISIBLE_CAP reduced to ${this.currentVisibleCap}`);

				this.resolveVisibility();
			} else if (this.lowLoadStreak >= CPU_SUSTAINED_SAMPLES_REQUIRED && this.currentVisibleCap < VISIBLE_CAP_CEILING) {
				this.currentVisibleCap += 1;
				this.lowLoadStreak = 0;

				logger.info(`Load governor: sustained low load (${load1.toFixed(2)}) — VISIBLE_CAP restored to ${this.currentVisibleCap}`);

				this.resolveVisibility();
			}
		} catch (error) {
			logger.error(`Error sampling CPU load: ${error.message}`);
		}
	}
}



// create the instance
const triggerEngine = new TriggerEngine();

// export for use in other modules
export default triggerEngine;
