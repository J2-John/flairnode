// EnvironmentConfig.mjs
// single source of truth for which Flair cloud environment this firmware talks to
// copyright 2025 Drew Shipps, J Squared Systems


// set to true to use the *.test local dev API instead of production (FOR DEVELOPMENT ONLY)
const USE_LOCALHOST = false;

// checks whether we're running on macOS (laptop dev mode) or not
const LAPTOP_MODE = (process.platform === 'darwin');

// default base host used when FLAIR_BASE_HOST isn't set in the environment
const DEFAULT_BASE_HOST = (USE_LOCALHOST && LAPTOP_MODE)
	? 'http://flairled.test'
	: 'https://flairled.com';

// the base host every cloud URL is built from. NetworkModule (sync) and
// ContentDownloadManager (content downloads) both derive their URLs from this
// single value, so a unit can never end up syncing against one cloud while
// downloading content from another. To point a unit at a different
// environment (e.g. staging), set the FLAIR_BASE_HOST env var in that unit's
// pm2 process config (include the scheme, e.g. https://your-staging-host.example.com) —
// never hand-edit this file to switch a unit's cloud.
const BASE_HOST = process.env.FLAIR_BASE_HOST || DEFAULT_BASE_HOST;

// The firmware version this unit is running, reported to the cloud on every
// sync (added 2026-09-04, review M23 / C1 phase 2). Read once at boot from the
// VERSION file beside this module — the file tools/release.ps1 writes when a
// release is cut, whose content equals the git tag. Until a release has been
// cut this reports 'unversioned', which is the honest answer: update.sh
// installs whatever main is at that second.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

function readFirmwareVersion() {
	try {
		const versionPath = join(dirname(fileURLToPath(import.meta.url)), 'VERSION');
		const version = readFileSync(versionPath, 'utf8').trim();
		return version.length > 0 ? version.slice(0, 64) : 'unversioned';
	} catch (error) {
		return 'unversioned';
	}
}

const FIRMWARE_VERSION = readFirmwareVersion();


export default {
	USE_LOCALHOST,
	LAPTOP_MODE,
	BASE_HOST,
	FIRMWARE_VERSION,
};
