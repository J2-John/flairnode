// TriggerEngine.mjs
// device-side trigger engine for the Flair Node firmware (roadmap 29b, phase 3)
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the TriggerEngine javascript object,
// which owns all trigger STATE and DECISION logic: edge detection on Sense port
// data, per-port fire/expiry timing, visibility resolution (priority + overlap +
// cap), and the CPU load governor. It never touches UDPManager, RenderSocketClient,
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
import { getCanvasDimensions } from './CanvasDimensions.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('TriggerEngine');



// ==================== CONSTANTS ====================

// Locked ruleset (roadmap 29b phase 3): recompute visibility on every
// fire/expiry, and (implicitly, this module's own extension) on every
// governor cap change too — a cap change without a recompute would leave
// stale visibility standing.
const EXPIRY_CHECK_INTERVAL_MS = 1000;  // how often to sweep for expired triggers

// ---- Load governor: calibrate in phase 4 bench testing ----
// These five numbers are the entire tuning surface for the governor. None
// of them are derived from real hardware measurement yet — they're
// placeholder values chosen to be directionally reasonable (os.loadavg()[0]
// is a Linux 1-minute load average; on a quad-core Pi, a load of ~4 means
// "fully busy across all cores"), not measured. Revisit all five once
// phase 4 has real bench numbers for sustained decode load under N visible
// triggers.
const CPU_SAMPLE_INTERVAL_MS = 5000;       // calibrate in phase 4 bench testing
const CPU_LOAD_THRESHOLD_HIGH = 3.5;       // calibrate in phase 4 bench testing
const CPU_LOAD_THRESHOLD_LOW = 2.0;        // calibrate in phase 4 bench testing
const CPU_SUSTAINED_SAMPLES_REQUIRED = 3;  // calibrate in phase 4 bench testing — consecutive samples before acting
const VISIBLE_CAP_DEFAULT = 4;             // calibrate in phase 4 bench testing
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
		// Object.keys(this.portState). Everything active-but-not-in-this-set
		// stays hidden but keeps counting down (locked ruleset §4).
		this.visiblePorts = new Set();

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
			let anyFired = false;

			for (let i = 0; i < dataArray.length; i++) {
				const port = i + 1;
				const isActive = dataArray[i] === 1;
				const wasActive = this.previousSenseData[i] === 1;

				// FIRE only on the inactive->active edge — holding active
				// across packets is not a re-fire (locked ruleset §2).
				if (isActive && !wasActive) {
					if (this.fireTrigger(port, now)) {
						anyFired = true;
					}
				}
			}

			this.previousSenseData = dataArray;

			if (anyFired) {
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

		// Re-fire restarts the countdown (new expiresAt) whether currently
		// visible or hidden (locked ruleset §3) — a plain overwrite already
		// gives us exactly that, visible or not.
		this.portState[port] = {
			sceneId: triggerConfig.scene_id,
			firedAt: now,
			expiresAt: now + (durationSeconds * 1000),
		};

		logger.info(`Trigger port ${port} ${isReFire ? 're-fired' : 'fired'} -> scene ${triggerConfig.scene_id}, expires in ${durationSeconds}s`);

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
	// AND governor cap change (locked ruleset §4 says "every fire/expiry";
	// a cap change is this module's own necessary extension of that same
	// principle — leaving stale visibility standing after the cap itself
	// changed would defeat the governor). Iterates active ports HIGHEST
	// PORT FIRST (highest priority), accepting a port if its overlay rect
	// doesn't overlap any already-accepted rect AND the cap isn't full.
	resolveVisibility() {
		try {
			const activePorts = Object.keys(this.portState)
				.map(Number)
				.sort((a, b) => b - a);  // descending: higher port = higher priority

			const accepted = [];
			const acceptedRects = [];

			for (const port of activePorts) {
				if (accepted.length >= this.currentVisibleCap) break;

				const rect = this.getOverlayRect(this.portState[port].sceneId);
				const overlaps = acceptedRects.some(r => this.rectsOverlap(rect, r));

				if (!overlaps) {
					accepted.push(port);
					acceptedRects.push(rect);
				}
			}

			const acceptedSet = new Set(accepted);
			const previouslyVisible = this.visiblePorts;

			// newly visible -> show
			for (const port of accepted) {
				if (!previouslyVisible.has(port)) {
					this.showTrigger(port);
				}
			}

			// no longer accepted (expired OR lost the priority/overlap contest) -> hide
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


	// getOverlayRect - a scene's overlay rect in packed-canvas pixels, or
	// the full-canvas rect when metadata is null (locked ruleset §4: "null
	// metadata = full-canvas rect (conflicts with everything)"). A scene_id
	// that doesn't resolve to a known scene at all gets the SAME
	// conservative full-canvas treatment — we can't know its real
	// footprint, so assume the worst rather than let it slip through the
	// overlap check unchecked.
	getOverlayRect(sceneId) {
		const scene = configManager.getScenes()?.find(s => s.id === sceneId);
		const { width, height } = getCanvasDimensions();

		if (!scene) {
			return { x: 0, y: 0, width, height };
		}

		const hasOverlay = scene.overlay_x != null && scene.overlay_y != null
			&& scene.overlay_width != null && scene.overlay_height != null;

		if (!hasOverlay) {
			return { x: 0, y: 0, width, height };
		}

		return {
			x: scene.overlay_x,
			y: scene.overlay_y,
			width: scene.overlay_width,
			height: scene.overlay_height,
		};
	}


	// rectsOverlap - standard AABB overlap test. Touching edges (a.x + a.width
	// === b.x) do NOT count as overlapping — only genuine area intersection does.
	rectsOverlap(a, b) {
		if (!a || !b) return true;  // defensive: treat a missing rect as full-canvas

		return a.x < b.x + b.width && a.x + a.width > b.x
			&& a.y < b.y + b.height && a.y + a.height > b.y;
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
