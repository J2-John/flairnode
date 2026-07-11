#!/usr/bin/env node
// bench/fire-trigger.mjs
// Sense packet simulator, for roadmap 29b phase 4 trigger-engine bench testing
// copyright 2025 Drew Shipps, J Squared Systems


// This is a standalone script — it does not import any FlairNode app module.
// It builds and sends a UDP packet that is byte-for-byte indistinguishable
// from a real Flair Sense broadcast, straight at this Pi's own UDPManager
// (127.0.0.1:6455), so a single invocation exercises the ENTIRE device-side
// path exactly as production traffic would:
//   UDP socket receipt -> UDPManager.validateIncomingPacket() -> the
//   'receivedUDP' eventHub emit -> PlaybackController.handleNewSenseData()'s
//   pairing guard + validateSenseDataObject() -> TriggerEngine.
//   processSenseData()'s inactive->active edge detection.
//
// Packet shape mirrors UDPManager.mjs's validateIncomingPacket() (NAME,
// TYPE, ID, VERSION required; TYPE must be 1 for Sense) and
// PlaybackController.mjs's validateSenseDataObject() (DATA = exactly 19
// comma-separated '0'/'1' values, index i = port i+1) and pairing guard
// (SERIAL must equal configManager's assigned_sense_serial, when set).
//
// Usage:
//   node bench/fire-trigger.mjs <port>               fire an edge on <port>: inactive baseline,
//                                                     then <port> active, hold 2s, then release
//   node bench/fire-trigger.mjs <port> --hold 5       same, but hold active for 5s before releasing
//   node bench/fire-trigger.mjs <port> --release      send ONLY the release (all-inactive) packet,
//                                                     e.g. to release a port left held from a prior run
//   node bench/fire-trigger.mjs --all-inactive        send a single all-ports-inactive baseline packet,
//                                                     for resetting state between test runs
//   node bench/fire-trigger.mjs <port> --serial X     override the SERIAL field (default: read this
//                                                     Pi's own assigned_sense_serial out of config.json,
//                                                     so the pairing guard passes exactly as it would
//                                                     for a real paired Sense)
//
// Must be run on the Pi (or wherever the FlairNode process + config.json live).


import fs from 'fs';
import path from 'path';
import dgram from 'dgram';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);



// ==================== CONSTANTS ====================

const UDP_PORT = 6455;          // must match UDPManager.mjs's UDP_PORT exactly
const TARGET_HOST = '127.0.0.1';
const PORT_COUNT = 19;          // must match validateSenseDataObject's expected DATA length
const DEFAULT_HOLD_SECONDS = 2;
const EDGE_GAP_MS = 200;        // gap between baseline and edge packets, so they're unambiguously two sends



// ==================== USAGE ====================

const USAGE = `
Usage:
  node bench/fire-trigger.mjs <port> [--hold N] [--release] [--serial X]
  node bench/fire-trigger.mjs --all-inactive [--serial X]

  <port>            trigger port to fire, 1-${PORT_COUNT}
  --hold N          seconds to hold active before auto-releasing (default: ${DEFAULT_HOLD_SECONDS})
  --release         send ONLY the release (all-inactive) packet for <port>, skip the baseline+fire
  --all-inactive    send a single all-ports-inactive baseline packet (no <port> required)
  --serial X        override the SERIAL field (default: this node's own assigned_sense_serial
                     from config.json, so the pairing guard passes as it would for a real Sense)
`;

function printUsageAndExit(message) {
	if (message) console.error(`Error: ${message}`);
	console.error(USAGE);
	process.exit(1);
}



// ==================== ARGUMENT PARSING ====================

const rawArgs = process.argv.slice(2);

const VALUE_FLAGS = new Set(['--hold', '--serial']);
const BOOL_FLAGS = new Set(['--release', '--all-inactive']);

let portArg = null;
const flags = {};

for (let i = 0; i < rawArgs.length; i++) {
	const arg = rawArgs[i];

	if (VALUE_FLAGS.has(arg)) {
		flags[arg] = rawArgs[i + 1];
		i++; // consume the value too
	} else if (BOOL_FLAGS.has(arg)) {
		flags[arg] = true;
	} else if (portArg === null) {
		portArg = arg;
	} else {
		printUsageAndExit(`Unrecognized argument: ${arg}`);
	}
}

const allInactive = flags['--all-inactive'] === true;
const releaseOnly = flags['--release'] === true;
const serialOverride = flags['--serial'] ?? null;

const holdSeconds = Number(flags['--hold'] ?? DEFAULT_HOLD_SECONDS);
if (Number.isNaN(holdSeconds) || holdSeconds <= 0) {
	printUsageAndExit(`--hold must be a positive number of seconds, got "${flags['--hold']}"`);
}

let port = null;
if (!allInactive) {
	if (portArg === null) {
		printUsageAndExit('Missing required <port> argument.');
	}

	port = Number(portArg);
	if (!Number.isInteger(port) || port < 1 || port > PORT_COUNT) {
		printUsageAndExit(`<port> must be an integer between 1 and ${PORT_COUNT}, got "${portArg}"`);
	}
}



// ==================== SERIAL RESOLUTION ====================

// resolveSerial - default to this node's own assigned_sense_serial, read
// straight out of config.json, so the packet passes PlaybackController's
// pairing guard exactly as a real paired Sense would. If nothing is paired
// yet, the guard is skipped entirely regardless of SERIAL (see
// PlaybackController.mjs), so any placeholder value is fine in that case.
// Resolved relative to this script's own location (not process.cwd()) so it
// works no matter what directory you invoke it from.
function resolveSerial() {
	if (serialOverride) return serialOverride;

	try {
		const configPath = path.join(__dirname, '..', 'config.json');
		const raw = fs.readFileSync(configPath, 'utf8');
		const config = JSON.parse(raw);

		if (config.assigned_sense_serial) {
			return config.assigned_sense_serial;
		}
	} catch (err) {
		// no config.json yet, or it's unreadable/malformed — fall through
	}

	return 'BENCH-SIM-SENSE';
}



// ==================== PACKET BUILDING ====================

// buildDataString - 19-value comma-separated binary string. activePort is
// 1-indexed; null means all-inactive.
function buildDataString(activePort) {
	const values = new Array(PORT_COUNT).fill('0');

	if (activePort !== null) {
		values[activePort - 1] = '1';
	}

	return values.join(',');
}

function buildPacket(dataString, serial) {
	return {
		NAME: 'Flair Sense (bench simulator)',
		TYPE: 1,
		ID: 'BENCH-SIM',
		VERSION: '1.0.0',
		SERIAL: serial,
		DATA: dataString,
	};
}



// ==================== SENDING ====================

const socket = dgram.createSocket('udp4');

socket.on('error', (err) => {
	console.error(`Socket error: ${err.message}`);
	process.exit(1);
});

function sendPacket(packet) {
	return new Promise((resolve, reject) => {
		const json = JSON.stringify(packet);

		socket.send(json, 0, json.length, UDP_PORT, TARGET_HOST, (err) => {
			if (err) return reject(err);
			console.log(`  sent -> ${json}`);
			resolve();
		});
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}



// ==================== MAIN ====================

async function main() {
	const serial = resolveSerial();
	console.log(`Using SERIAL: ${serial}`);

	if (allInactive) {
		console.log('Sending all-ports-inactive baseline packet...');
		await sendPacket(buildPacket(buildDataString(null), serial));
		socket.close();
		return;
	}

	if (releaseOnly) {
		console.log(`Releasing port ${port} (sending all-inactive packet)...`);
		await sendPacket(buildPacket(buildDataString(null), serial));
		socket.close();
		return;
	}

	console.log(`Simulating a Sense press on port ${port}, hold ${holdSeconds}s`);

	console.log('1/3 sending inactive baseline...');
	await sendPacket(buildPacket(buildDataString(null), serial));

	await sleep(EDGE_GAP_MS);

	console.log(`2/3 sending port ${port} ACTIVE (the inactive->active edge)...`);
	await sendPacket(buildPacket(buildDataString(port), serial));

	console.log(`holding for ${holdSeconds}s...`);
	await sleep(holdSeconds * 1000);

	console.log(`3/3 sending port ${port} INACTIVE (release)...`);
	await sendPacket(buildPacket(buildDataString(null), serial));

	socket.close();
}

main().catch((err) => {
	console.error(`fire-trigger.mjs failed: ${err.message}`);
	process.exit(1);
});
