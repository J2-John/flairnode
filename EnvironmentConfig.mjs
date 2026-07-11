// EnvironmentConfig.mjs
// single source of truth for which Flair cloud environment this firmware talks to
// copyright 2025 Drew Shipps, J Squared Systems


// set to true to use the *.test local dev API instead of production (FOR DEVELOPMENT ONLY)
const USE_LOCALHOST = false;

// checks whether we're running on macOS (laptop dev mode) or not
const LAPTOP_MODE = (process.platform === 'darwin');

// the base host every cloud URL is built from. NetworkModule (sync) and
// ContentDownloadManager (content downloads) both derive their URLs from this
// single value, so a unit can never end up syncing against one cloud while
// downloading content from another. To point a device at a different
// environment (e.g. staging), change BASE_HOST here — nowhere else.
const BASE_HOST = (USE_LOCALHOST && LAPTOP_MODE)
	? 'http://flairled.test'
	: 'https://flairled.com';


export default {
	USE_LOCALHOST,
	LAPTOP_MODE,
	BASE_HOST,
};
