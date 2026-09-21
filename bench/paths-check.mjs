#!/usr/bin/env node
// bench/paths-check.mjs
// Checks where the firmware reads and writes its files, in both on-disk
// layouts, using the REAL modules. Throwaway-tool convention, same as
// bench/provisioning-harness.mjs: never imported by FlairNode.js, never run in
// production.
//
// WHY THIS EXISTS. The release-folder updater runs the app from
// ~/flairnode/releases/<version>/ through a `current` symlink. Before Paths.mjs,
// three modules found their files relative to wherever the process was started
// and two relative to the code itself — and in a release folder the second kind
// looks for id.json in ~/flairnode/releases/. A node that cannot find its
// identity asks the cloud for it again, and since ac232f3 the cloud REFUSES
// unless a superadmin opens a window. So a wrong path here is a wall stuck on
// CONNECTING... after an update.
//
// It builds real directory trees under a temp dir, copies the firmware into
// them, and runs a child `node` process in each to report what the modules
// resolved. A child per case, because module-level constants are fixed at
// import time and ESM caches imports for the life of a process.
//
// Usage:   node bench/paths-check.mjs
//          (from anywhere — it finds the repo from its own location)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
	if (actual === expected) {
		pass++;
		console.log(`  PASS  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL  ${label}\n          expected: ${expected}\n          actual:   ${actual}`);
	}
}

// Copy the firmware's own files (not node_modules — symlinked, it is large and
// read-only here) into a directory.
function installFirmware(dir) {
	fs.mkdirSync(dir, { recursive: true });
	for (const name of fs.readdirSync(REPO)) {
		if (name === 'node_modules' || name === '.git' || name === 'bench' || name === 'tools') continue;
		const src = path.join(REPO, name);
		if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, name));
	}
	fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
}

// Ask a child process, started in `cwd` against the entry path `entryDir`,
// what every module resolved. Prints one JSON line and exits.
function resolveIn(entryDir, cwd, env = {}) {
	const probe = `
		const P = await import(${JSON.stringify(path.join(entryDir, 'Paths.mjs'))});
		const Id = await import(${JSON.stringify(path.join(entryDir, 'IdManager.mjs'))});
		const Cfg = (await import(${JSON.stringify(path.join(entryDir, 'ConfigManager.mjs'))})).default;
		const Net = (await import(${JSON.stringify(path.join(entryDir, 'NetworkModule.mjs'))})).default;
		const Mac = await import(${JSON.stringify(path.join(entryDir, 'MacrosModule.mjs'))});
		const Cdm = await import(${JSON.stringify(path.join(entryDir, 'ContentDownloadManager.mjs'))});
		P.ensureLayout();
		console.log(JSON.stringify({
			layout: P.LAYOUT,
			app: P.APP_DIR,
			data: P.DATA_DIR,
			id: P.ID_JSON_PATH,
			idManager: Id.ID_JSON_PATH,
			config: Cfg.filePath,
			missed: Net.filePath,
			macro: Mac.MACRO_ACTION_FILE_PATH,
			content: Cdm.CONTENT_OUTPUT_DIR,
			pageContent: fs.realpathSync(path.join(P.APP_DIR, 'content')),
		}));
		process.exit(0);
	`;
	const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import fs from 'fs';${probe}`], {
		cwd,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
		timeout: 20000,
	});
	const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
	return JSON.parse(line);
}

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flair-paths-')));

// ------------------------------------------------------------------ flat
// Today's layout: the app IS ~/flairnode. Every path must resolve exactly as
// the pre-Paths.mjs code did when started from ~/flairnode, which is how pm2
// runs every unit in the field.
console.log('\nFLAT LAYOUT (today)');
{
	const home = path.join(ROOT, 'flat', 'home');
	const app = path.join(home, 'flairnode');
	installFirmware(app);
	fs.mkdirSync(path.join(app, 'content'), { recursive: true });

	const r = resolveIn(app, app);
	check('layout detected as flat', r.layout, 'flat');
	check('data lives in the app dir, as before', r.data, app);
	check('id.json is ~/id.json, as before', r.id, path.join(home, 'id.json'));
	check('IdManager uses the same id path', r.idManager, r.id);
	check('config.json in the app dir, as before', r.config, path.join(app, 'config.json'));
	check('missed messages in the app dir, as before', r.missed, path.join(app, 'missedNetworkMessages.json'));
	check('macro guard file in the app dir, as before', r.macro, path.join(app, 'lastMacroActioned.json'));
	check('downloads go to app/content, as before', r.content, path.join(app, 'content'));
	check('render.html sees the same content folder', r.pageContent, path.join(app, 'content'));

	// NEW-F2: started from somewhere else, the old code wrote its files into
	// that somewhere else. Now they stay with the app.
	const elsewhere = path.join(ROOT, 'flat', 'elsewhere');
	fs.mkdirSync(elsewhere, { recursive: true });
	const r2 = resolveIn(app, elsewhere);
	check('F2: started from another dir, config still in the app dir', r2.config, path.join(app, 'config.json'));
	check('F2: started from another dir, macro file still in the app dir', r2.macro, path.join(app, 'lastMacroActioned.json'));
	check('F2: started from another dir, downloads still in app/content', r2.content, path.join(app, 'content'));
}

// ------------------------------------------------------------------ releases
// The updater's layout. The app runs from releases/<v>/ via `current`; state
// that must survive an update lives in shared/; id.json stays at ~/id.json.
console.log('\nRELEASE LAYOUT (updater)');
{
	const home = path.join(ROOT, 'rel', 'home');
	const root = path.join(home, 'flairnode');
	const rel = path.join(root, 'releases', '1.2.0');
	installFirmware(rel);
	fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
	fs.symlinkSync(path.join('releases', '1.2.0'), path.join(root, 'current'));

	// Entered through the symlink, the way pm2 will start it.
	const r = resolveIn(path.join(root, 'current'), path.join(root, 'current'));
	check('layout detected as release', r.layout, 'release');
	check('code dir is the real release dir', r.app, rel);
	check('data lives in shared/', r.data, path.join(root, 'shared'));
	check('id.json is STILL ~/id.json — same file as the flat layout', r.id, path.join(home, 'id.json'));
	check('IdManager uses the same id path', r.idManager, r.id);
	check('config.json in shared/', r.config, path.join(root, 'shared', 'config.json'));
	check('missed messages in shared/', r.missed, path.join(root, 'shared', 'missedNetworkMessages.json'));
	check('macro guard file in shared/', r.macro, path.join(root, 'shared', 'lastMacroActioned.json'));
	check('downloads go to shared/content', r.content, path.join(root, 'shared', 'content'));
	check('render.html in the release sees shared/content', r.pageContent, path.join(root, 'shared', 'content'));

	// A second release must see the SAME state — the whole point.
	const rel2 = path.join(root, 'releases', '1.3.0');
	installFirmware(rel2);
	fs.unlinkSync(path.join(root, 'current'));
	fs.symlinkSync(path.join('releases', '1.3.0'), path.join(root, 'current'));
	const r2 = resolveIn(path.join(root, 'current'), path.join(root, 'current'));
	check('next release: same config file', r2.config, r.config);
	check('next release: same id.json', r2.id, r.id);
	check('next release: its page sees the same content', r2.pageContent, r.pageContent);

	// ensureLayout is safe to run on every boot.
	const r3 = resolveIn(path.join(root, 'current'), path.join(root, 'current'));
	check('ensureLayout is idempotent', r3.pageContent, r.pageContent);
}

// ------------------------------------------------------------------ overrides
console.log('\nOVERRIDES (bench and testing only)');
{
	const home = path.join(ROOT, 'ovr', 'home');
	const app = path.join(home, 'flairnode');
	installFirmware(app);
	const data = path.join(ROOT, 'ovr', 'data');
	const id = path.join(ROOT, 'ovr', 'my-id.json');
	fs.mkdirSync(data, { recursive: true });
	const r = resolveIn(app, app, { FLAIR_DATA_DIR: data, FLAIR_ID_PATH: id });
	check('FLAIR_DATA_DIR wins', r.data, data);
	check('FLAIR_ID_PATH wins', r.id, id);
}

fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
