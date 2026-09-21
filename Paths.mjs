// Paths.mjs
// where every file the firmware reads or writes lives
// copyright 2026 J Squared Systems


// ONE place decides every path, so the app can run from either on-disk layout
// without any setting having to be right. Added 2026-09-21.
//
//   FLAT (every unit today)            RELEASE (the push updater)
//   ~/id.json                          ~/id.json                      <- same file
//   ~/flairnode/                       ~/flairnode/
//     FlairNode.js, render.html ...      releases/1.2.0/  FlairNode.js, render.html ...
//     config.json                        releases/1.3.0/
//     content/                           current -> releases/1.3.0
//                                        shared/  config.json, content/ ...
//
// WHY. Before this, five modules chose their own paths two different ways:
// "wherever the process was started" (config.json, missed messages, the macro
// guard file, downloads) and "relative to this code" (id.json, playback's
// content folder). In a release folder the second kind looks for id.json in
// ~/flairnode/releases/, and a node that cannot find its identity asks the
// cloud again — which since flairled ac232f3 is REFUSED until a superadmin
// opens a window. The first kind was already a live bug: started from any other
// directory, the files silently went there (NEW-F2).
//
// HOW THE LAYOUT IS CHOSEN. By what the directory structure says, not by a
// setting: if this code sits in a folder whose parent is named `releases`, it is
// the release layout; otherwise flat. Nothing on a new card has to be set for
// identity and settings to be found. FLAIR_DATA_DIR and FLAIR_ID_PATH override
// both, for bench tests only.
//
// THIS MODULE IMPORTS NOTHING FROM THE APP, so any module can use it without an
// import cycle, and it can be loaded on its own by a test.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';


// The real directory holding this code. realpath, so that when pm2 starts the
// app through ~/flairnode/current/, this is the actual release folder behind it.
export const APP_DIR = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));

const inReleaseFolder = path.basename(path.dirname(APP_DIR)) === 'releases';

// ~/flairnode in both layouts: the app dir itself when flat, the folder that
// holds releases/ otherwise.
const ROOT_DIR = inReleaseFolder ? path.dirname(path.dirname(APP_DIR)) : APP_DIR;

export const LAYOUT = inReleaseFolder ? 'release' : 'flat';

// State that must survive an update: settings, the offline message queue, the
// macro guard record, downloaded video.
export const DATA_DIR = process.env.FLAIR_DATA_DIR
	|| (inReleaseFolder ? path.join(ROOT_DIR, 'shared') : APP_DIR);

// Device identity and claim PIN. One level above ~/flairnode in BOTH layouts —
// the same file on disk before and after a unit moves to release folders, and
// deliberately outside anything an update replaces.
export const ID_JSON_PATH = process.env.FLAIR_ID_PATH
	|| path.join(ROOT_DIR, '..', 'id.json');

export const CONFIG_FILE_PATH = path.join(DATA_DIR, 'config.json');
export const MISSED_MESSAGES_FILE_PATH = path.join(DATA_DIR, 'missedNetworkMessages.json');
export const MACRO_ACTION_FILE_PATH = path.join(DATA_DIR, 'lastMacroActioned.json');
export const CONTENT_DIR = path.join(DATA_DIR, 'content');


// Make sure the browser can see the downloaded video.
//
// render.html loads video from `content/` BESIDE ITSELF. In the flat layout
// that is CONTENT_DIR already. In a release folder it would be an empty folder
// inside the release, so this links it to the shared one. Runs on every boot,
// does nothing if already right, and never throws: a failure here must not stop
// the app from starting, only be reported.
//
// Returns a short description of what it did, for the startup log.
export function ensureLayout() {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.mkdirSync(CONTENT_DIR, { recursive: true });

		const pageContent = path.join(APP_DIR, 'content');

		if (path.resolve(pageContent) === path.resolve(CONTENT_DIR)) {
			return 'content served from the data dir directly';
		}

		let current = null;
		try {
			current = fs.lstatSync(pageContent);
		} catch (err) {
			current = null;
		}

		if (current && current.isSymbolicLink()
			&& fs.realpathSync(pageContent) === fs.realpathSync(CONTENT_DIR)) {
			return 'content link already correct';
		}

		if (current && !current.isSymbolicLink()) {
			// A real folder where the link belongs — e.g. a release unpacked with
			// its own content/. Do not delete what might be someone's files;
			// leave it and say so.
			return `NOT LINKED: ${pageContent} is a real folder; the browser will not see ${CONTENT_DIR}`;
		}

		if (current) {
			fs.unlinkSync(pageContent);
		}
		fs.symlinkSync(CONTENT_DIR, pageContent);
		return `linked ${pageContent} -> ${CONTENT_DIR}`;
	} catch (err) {
		return `FAILED to prepare the layout: ${err.message}`;
	}
}
