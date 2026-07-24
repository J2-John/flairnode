// ProvisioningManager.mjs
// first-boot device identity provisioning for the Flair Node firmware
// copyright 2026 J Squared Systems


// this module creates a single instance of the ProvisioningManager
// javascript object, which ensures a valid id.json exists before IdManager
// (and everything downstream of it in FlairNode.js's whenReady() chain) is
// allowed to initialize. Previously a missing/invalid id.json silently
// degraded IdManager to id=0/'unknown!' and let boot continue anyway — every
// module downstream ran against a fake identity, and NetworkModule's sync
// loop just 400'd forever without ever explaining why (roadmap 17c; see
// CLAUDE.md). This module closes that gap: nothing downstream starts until
// there's a real identity on disk.



// import modules
import fs from 'fs';
import eventHub from './EventHub.mjs';
import fetch from 'node-fetch';

import Logger from './Logger.mjs';
const logger = new Logger('ProvisioningManager');

import environment from './EnvironmentConfig.mjs';
import renderSocketClient from './RenderSocketClient.mjs';
import { ID_JSON_PATH } from './IdManager.mjs';



// variables
const CPUINFO_PATH = '/proc/cpuinfo';

// same BASE_HOST every other cloud call in this firmware uses (NetworkModule,
// ContentDownloadManager) — never a second hostname mechanism.
const PROVISION_URL = `${environment.BASE_HOST}/api/v1/flair-node/provision`;

const RETRY_INTERVAL_MS = 60000;  // roadmap 17c ruling: no internet on first boot is expected, retry until it succeeds

const LAPTOP_MODE = (process.platform === 'darwin');

const CONNECTING_DISPLAY_TEXT = 'CONNECTING...';



// parseCpuSerial - tolerant extraction of the Serial field from raw
// /proc/cpuinfo text. Case-insensitive field match, any amount of
// whitespace around the colon, trims the value. Returns the value exactly
// as printed (no case normalization) — it's an opaque identifier sent to
// the cloud and compared for equality only, never computed with. Returns
// null if no Serial line is found (missing file content, corrupt/foreign
// cpuinfo, or genuinely absent on non-Pi hardware).
export function parseCpuSerial(cpuinfoText) {
	if (typeof cpuinfoText !== 'string') return null;

	const match = cpuinfoText.match(/^\s*serial\s*:\s*(\S+)\s*$/im);

	return match ? match[1] : null;
}


// readCpuSerial - reads CPUINFO_PATH from disk and extracts the Serial
// field. Never throws — any failure (missing file, permission error, no
// Serial line found) is logged and folded into a plain null return, so the
// retry loop can treat "couldn't get a serial" the same as any other
// reason to wait and try again.
function readCpuSerial() {
	try {
		const raw = fs.readFileSync(CPUINFO_PATH, 'utf8');
		const serial = parseCpuSerial(raw);

		if (!serial) {
			logger.error(`No Serial field found in ${CPUINFO_PATH}.`);
		}

		return serial;
	} catch (error) {
		logger.error(`Failed to read ${CPUINFO_PATH}: ${error.message}`);
		return null;
	}
}


// idFileIsValid - true only if id.json exists, parses, and has a usable
// device_id (positive integer, whether stored as a JSON number or a
// numeric string — a hand-edited file per the manual provisioning runbook
// may quote it) and a non-empty serialnumber. device_id === 0 is treated
// as invalid on purpose: that's IdManager's own failover sentinel, and a
// unit that somehow persisted it to disk needs re-provisioning, not a fast
// path into a guaranteed-400 sync loop (see CLAUDE.md's known gotcha).
// Deliberately does NOT require security_code — a unit provisioned by hand
// per the old runbook (device_id + serialnumber only) must still take the
// fast path below, not get re-provisioned just because that field is
// absent.
function idFileIsValid() {
	try {
		const raw = fs.readFileSync(ID_JSON_PATH, 'utf8');
		const parsed = JSON.parse(raw);

		const idNumeric = Number(parsed.device_id);
		const idOk = Number.isInteger(idNumeric) && idNumeric > 0;
		const serialOk = typeof parsed.serialnumber === 'string' && parsed.serialnumber.length > 0;

		return idOk && serialOk;
	} catch (error) {
		return false;
	}
}


// writeIdFile - persists all three fields the provision endpoint returns.
// security_code is kept even though IdManager.loadFromFile() doesn't read
// it today — the endpoint returns it idempotently for a reason, so it
// isn't discarded here just because nothing consumes it yet.
function writeIdFile({ node_id, serial_number, security_code }) {
	const contents = {
		device_id: node_id,
		serialnumber: serial_number,
		security_code: security_code,
	};

	fs.writeFileSync(ID_JSON_PATH, JSON.stringify(contents, null, 2));
}


// ---- display ----
// Reuses render.html's existing showSerialNumberScreen() as-is (wired to
// the 'show_serial_number' socket command) — it was already built to tile
// a string full-screen, readable across a room, for a different feature
// (admin-triggered "identify this unit"). No new render.html code needed.
let lastDisplayText = null;
let lastDisplaySecurityCode = null;

function pushDisplay(text, securityCode = null) {
	lastDisplayText = text;
	lastDisplaySecurityCode = securityCode;
	renderSocketClient.send('show_serial_number', { serial_number: text, security_code: securityCode });
}

// boot ordering between this module and the Chromium kiosk client
// connecting to RenderSocketClient is not guaranteed, so re-send whatever
// we last tried to show once the client actually connects — same pattern
// PlaybackController already uses for its own renderClientConnected +
// 1s-settle handling.
eventHub.on('renderClientConnected', () => {
	if (lastDisplayText === null) return;

	setTimeout(() => {
		renderSocketClient.send('show_serial_number', { serial_number: lastDisplayText, security_code: lastDisplaySecurityCode });
	}, 1000);
});


// attemptProvision - one full provisioning attempt: read the CPU serial,
// POST it to the cloud, write id.json on success. Returns the parsed
// {node_id, serial_number, security_code} response on success, or null on
// any failure (every failure reason is logged at the point it occurs, so
// the caller doesn't need to). cpuSerialOverride is a testability hook
// only — production callers (runUntilProvisioned, below) never pass it,
// so they always go through the real readCpuSerial()/proc/cpuinfo path;
// bench/provisioning-harness.mjs uses it to exercise the real network
// round trip from a dev machine, which has no /proc/cpuinfo to read.
export async function attemptProvision(cpuSerialOverride = null) {
	const cpuSerial = cpuSerialOverride ?? readCpuSerial();

	if (!cpuSerial) {
		return null;
	}

	let response;

	try {
		response = await fetch(PROVISION_URL, {
			method: 'POST',
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ cpu_serial: cpuSerial }),
		});
	} catch (error) {
		logger.error(`Provisioning request failed: ${error.message}`);
		return null;
	}

	if (!response.ok) {
		logger.error(`Provisioning request returned ${response.status} ${response.statusText}`);
		return null;
	}

	let result;

	try {
		result = await response.json();
	} catch (error) {
		logger.error(`Provisioning response was not valid JSON: ${error.message}`);
		return null;
	}

	if (!result.node_id || !result.serial_number) {
		logger.error(`Provisioning response missing expected fields: ${JSON.stringify(result)}`);
		return null;
	}

	writeIdFile(result);
	logger.info(`Provisioned successfully as ${result.serial_number} (node_id ${result.node_id}).`);

	return result;
}



// define the ProvisioningManager class
class ProvisioningManager {

	// init function
	init() {
		logger.info('Checking device identity...');

		if (LAPTOP_MODE) {
			// preserve exact current dev behavior, unchanged: IdManager's own
			// LAPTOP_MODE fallback (fake id 1 / FN-0000001) handles this —
			// provisioning never engages on a dev laptop.
			logger.info('LAPTOP_MODE — skipping provisioning, deferring to IdManager fallback.');
			eventHub.emit('moduleReady', 'ProvisioningManager');
			return;
		}

		if (idFileIsValid()) {
			// exact current fast path for an already-provisioned unit: valid
			// id.json exists, nothing to do, no display interaction at all.
			eventHub.emit('moduleReady', 'ProvisioningManager');
			return;
		}

		logger.warn(`${ID_JSON_PATH} is missing or invalid — entering first-boot provisioning.`);
		pushDisplay(CONNECTING_DISPLAY_TEXT);

		this.runUntilProvisioned();
	}


	// runUntilProvisioned - retries every RETRY_INTERVAL_MS until
	// attemptProvision() succeeds. Never gives up on its own: no internet on
	// first boot is an accepted case (roadmap 17c ruling), recovered the
	// moment connectivity returns without needing a physical power cycle.
	// moduleReady('ProvisioningManager') — and therefore IdManager.init(),
	// gated on it in FlairNode.js — is withheld for the entire duration.
	async runUntilProvisioned() {
		const result = await attemptProvision();

		if (result) {
			pushDisplay(result.serial_number, result.security_code);
			eventHub.emit('moduleReady', 'ProvisioningManager');
			return;
		}

		logger.warn(`Provisioning attempt failed — retrying in ${RETRY_INTERVAL_MS / 1000}s.`);
		setTimeout(() => this.runUntilProvisioned(), RETRY_INTERVAL_MS);
	}
}



// create and export an instance
const provisioningManager = new ProvisioningManager();

export default provisioningManager;
