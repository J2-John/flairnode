#!/usr/bin/env node
// bench/provisioning-harness.mjs
// Dev-machine test harness for ProvisioningManager.mjs (roadmap 17c),
// standing in for the physical Pi acceptance test until hardware is
// available. Same throwaway-tool convention as bench/fire-trigger.mjs:
// not imported by FlairNode.js, not run in production, exercises REAL
// code paths (the real parser, a real fetch against the real staging
// endpoint, a real id.json read/write) rather than mocks.
//
// Explicitly does NOT and CANNOT test two things, both deferred to the
// hardware session tomorrow:
//   - reading the real /proc/cpuinfo (doesn't exist off-Linux)
//   - the physical full-screen display (no Chromium kiosk client here)
//
// Usage (run each mode as its own separate invocation — see NOTE below):
//   node bench/provisioning-harness.mjs parser
//     Feeds parseCpuSerial() a handful of synthetic /proc/cpuinfo fixtures
//     (normal format, extra whitespace, uppercase hex, missing Serial
//     line, etc.) and checks each extracts (or cleanly fails) as expected.
//     No network, no filesystem writes.
//
//   node bench/provisioning-harness.mjs network
//     Calls the REAL attemptProvision() against the REAL FLAIR_BASE_HOST
//     (staging, unless overridden) with a clearly-fake cpu_serial
//     ("TEST-DEV-HARNESS-001"), twice in a row, and checks: request
//     succeeds, response has all 3 fields, id.json gets written with all
//     3 fields, and the second call (idempotent re-provision of the same
//     cpu_serial) returns the identical identity rather than a new one.
//     This creates one row in staging's flair_nodes table — the node_id
//     is printed clearly at the end so it can be noted or deleted.
//     Backs up any pre-existing id.json before running and restores it
//     (or removes the harness-written one) when done, even on failure.
//
//     NOTE: a prior staging run of this mode already burned serial
//     FN-00004 — the serial pool is auto-increment-derived, so that gap is
//     permanent (deleting the flair_nodes row does not reclaim the
//     serial). Expect the next run to allocate FN-00005, not FN-00004.
//
//   node bench/provisioning-harness.mjs retry
//     Points FLAIR_BASE_HOST at an unreachable local address
//     (http://127.0.0.1:1 — nothing listens there, so this fails fast
//     with ECONNREFUSED rather than hanging on a DNS lookup or a
//     blackholed connection) and calls attemptProvision() three times in
//     a row, asserting every call resolves cleanly to null and never
//     throws. This validates the exact function runUntilProvisioned()'s
//     retry loop depends on never crashing the process — it deliberately
//     does NOT sit through the real 60s RETRY_INTERVAL_MS between calls
//     (that's a plain setTimeout, not something worth spending real
//     wall-clock time "testing"); it re-invokes attemptProvision()
//     directly instead, back to back.
//
// NOTE on running one mode per invocation: ProvisioningManager.mjs is
// imported dynamically, after this script sets FLAIR_BASE_HOST for the
// "retry" case — Node's ES module cache means a second dynamic import of
// the same module within one process would silently reuse the first
// import's already-resolved PROVISION_URL, ignoring a changed env var.
// Running each mode as its own `node ...` invocation (a fresh process,
// fresh module cache) sidesteps that entirely, same as fire-trigger.mjs's
// one-shot-per-invocation style.

import fs from 'fs';



// ==================== USAGE ====================

const USAGE = `
Usage:
  node bench/provisioning-harness.mjs parser
  node bench/provisioning-harness.mjs network
  node bench/provisioning-harness.mjs retry

  parser    CPU-serial parser fixtures — no network, no filesystem writes
  network   real round trip against FLAIR_BASE_HOST with a fake cpu_serial,
            called twice (idempotency check) — writes/restores real id.json
  retry     attemptProvision() against an unreachable host, 3x in a row —
            writes nothing (every attempt should fail cleanly)
`;

const mode = process.argv[2];

if (!['parser', 'network', 'retry'].includes(mode)) {
	console.error(USAGE);
	process.exit(1);
}



// ==================== SHARED ====================

const TEST_CPU_SERIAL = 'TEST-DEV-HARNESS-001';
const UNREACHABLE_BASE_HOST = 'http://127.0.0.1:1'; // nothing listens on port 1 — ECONNREFUSED immediately, no DNS/hang risk

let passCount = 0;
let failCount = 0;

function pass(label) {
	passCount++;
	console.log(`  PASS — ${label}`);
}

function fail(label, detail) {
	failCount++;
	console.error(`  FAIL — ${label}${detail ? ` (${detail})` : ''}`);
}

function summarize() {
	console.log(`\n${passCount} passed, ${failCount} failed.`);
	process.exit(failCount > 0 ? 1 : 0);
}



// ==================== MODE: parser ====================

async function runParserFixtures() {
	const { parseCpuSerial } = await import('../ProvisioningManager.mjs');

	console.log('Running CPU-serial parser fixtures (no network, no I/O)...\n');

	const fixtures = [
		{
			label: 'normal Pi 5 format (tab-separated, real field layout)',
			text: 'Hardware\t: BCM2835\nRevision\t: c03130\nSerial\t\t: 100000009c352a1b\nModel\t\t: Raspberry Pi 5 Model B Rev 1.0\n',
			expected: '100000009c352a1b',
		},
		{
			label: 'extra whitespace around the colon and trailing',
			text: 'Serial   :    100000009c352a1b   \n',
			expected: '100000009c352a1b',
		},
		{
			label: 'uppercase hex value (case preserved, not normalized)',
			text: 'Serial: 100000009C352A1B\n',
			expected: '100000009C352A1B',
		},
		{
			label: 'uppercase field name ("SERIAL")',
			text: 'Hardware: BCM2835\nSERIAL          : abc123def456\n',
			expected: 'abc123def456',
		},
		{
			label: 'missing Serial line entirely',
			text: 'Hardware\t: BCM2835\nRevision\t: c03130\nModel\t\t: Raspberry Pi 5 Model B Rev 1.0\n',
			expected: null,
		},
		{
			label: 'empty string',
			text: '',
			expected: null,
		},
		{
			label: 'non-string input (defensive — should never throw)',
			text: undefined,
			expected: null,
		},
	];

	for (const fixture of fixtures) {
		try {
			const result = parseCpuSerial(fixture.text);

			if (result === fixture.expected) {
				pass(fixture.label);
			} else {
				fail(fixture.label, `expected ${JSON.stringify(fixture.expected)}, got ${JSON.stringify(result)}`);
			}
		} catch (error) {
			fail(fixture.label, `threw: ${error.message}`);
		}
	}

	summarize();
}



// ==================== MODE: network ====================

async function runNetworkRoundTrip() {
	// import AFTER any env setup this mode needs — none here, we want the
	// real FLAIR_BASE_HOST (staging), unmodified.
	const provisioningManager = await import('../ProvisioningManager.mjs');
	const { ID_JSON_PATH } = await import('../IdManager.mjs');

	console.log(`Testing real round trip against FLAIR_BASE_HOST (${process.env.FLAIR_BASE_HOST || '(default, see EnvironmentConfig.mjs)'})...`);
	console.log(`Using cpu_serial: ${TEST_CPU_SERIAL}\n`);

	// back up any pre-existing id.json so this test can't clobber real
	// dev-machine state; restore it (or remove the harness-written file)
	// no matter how the test ends.
	const hadExisting = fs.existsSync(ID_JSON_PATH);
	const backup = hadExisting ? fs.readFileSync(ID_JSON_PATH, 'utf8') : null;

	function restore() {
		if (hadExisting) {
			fs.writeFileSync(ID_JSON_PATH, backup);
			console.log(`\nRestored pre-existing id.json at ${ID_JSON_PATH}.`);
		} else if (fs.existsSync(ID_JSON_PATH)) {
			fs.unlinkSync(ID_JSON_PATH);
			console.log(`\nRemoved harness-written id.json at ${ID_JSON_PATH} (none existed before this test).`);
		}
	}

	try {
		console.log('1/4 first attemptProvision() call...');
		const first = await provisioningManager.attemptProvision(TEST_CPU_SERIAL);

		if (!first || !first.node_id || !first.serial_number || !first.security_code) {
			fail('first call returned a usable {node_id, serial_number, security_code}', JSON.stringify(first));
			return summarize();
		}
		pass('first call returned node_id, serial_number, and security_code');

		console.log(`  -> node_id: ${first.node_id}, serial_number: ${first.serial_number}, security_code: ${first.security_code}`);

		console.log('2/4 checking id.json was written with all 3 fields...');
		const written = JSON.parse(fs.readFileSync(ID_JSON_PATH, 'utf8'));

		if (written.device_id === first.node_id && written.serialnumber === first.serial_number && written.security_code === first.security_code) {
			pass('id.json contains all 3 fields matching the response');
		} else {
			fail('id.json contents match the response', JSON.stringify(written));
		}

		console.log('3/4 second attemptProvision() call, same cpu_serial (idempotency)...');
		const second = await provisioningManager.attemptProvision(TEST_CPU_SERIAL);

		if (second && second.node_id === first.node_id && second.serial_number === first.serial_number && second.security_code === first.security_code) {
			pass('idempotent re-call returned the identical identity, not a new one');
		} else {
			fail('idempotent re-call matched the first', `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
		}

		console.log('4/4 done.');
		console.log(`\n>>> Staging flair_nodes row created: node_id ${first.node_id} (serial_number ${first.serial_number}), cpu_serial "${TEST_CPU_SERIAL}" — note or delete as needed. <<<`);
	} catch (error) {
		fail('network round trip completed without throwing', error.message);
	} finally {
		restore();
	}

	summarize();
}



// ==================== MODE: retry ====================

async function runRetryAgainstUnreachableHost() {
	process.env.FLAIR_BASE_HOST = UNREACHABLE_BASE_HOST;

	const provisioningManager = await import('../ProvisioningManager.mjs');
	const { ID_JSON_PATH } = await import('../IdManager.mjs');

	console.log(`Testing attemptProvision() against an unreachable host (${UNREACHABLE_BASE_HOST}), 3 calls in a row...\n`);

	const existedBefore = fs.existsSync(ID_JSON_PATH);

	for (let i = 1; i <= 3; i++) {
		try {
			const result = await provisioningManager.attemptProvision(TEST_CPU_SERIAL);

			if (result === null) {
				pass(`call ${i}/3 resolved cleanly to null (no throw)`);
			} else {
				fail(`call ${i}/3 resolved to null`, `got ${JSON.stringify(result)}`);
			}
		} catch (error) {
			fail(`call ${i}/3 did not throw`, error.message);
		}
	}

	const existsAfter = fs.existsSync(ID_JSON_PATH);
	if (existedBefore === existsAfter) {
		pass('id.json untouched (no file created/removed by failed attempts)');
	} else {
		fail('id.json untouched', `existed before: ${existedBefore}, exists after: ${existsAfter}`);
	}

	summarize();
}



// ==================== MAIN ====================

if (mode === 'parser') {
	runParserFixtures();
} else if (mode === 'network') {
	runNetworkRoundTrip();
} else if (mode === 'retry') {
	runRetryAgainstUnreachableHost();
}
