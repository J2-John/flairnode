// ContentDownloadManager.mjs
// content download manager for the Flair Node firmware
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the ContentDownloadManager javascript object,
// which handles file downloads and purging of unused content from the filesystem


// import modules
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('ContentDownloadManager');

import configManager from './ConfigManager.mjs';
import environment from './EnvironmentConfig.mjs';



// variables
const CONTENT_DOWNLOAD_URL = `${environment.BASE_HOST}/storage/scene_renders/`;

const OUTPUT_DIR = path.resolve('./content');
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes
// TODO: known boot delay, revisit once Pi 5 startup timing is validated
const INITIAL_SCAN_DELAY_MS = 20000;  // wait 20 seconds before first scan
const MAX_RETRY_ATTEMPTS = 1; // retry set to 1 because this thing is running pretty often anyway



// Define the ContentDownloadManager class
class ContentDownloadManager {

	// constructor
	constructor() {
		this.queue = [];
		this.activeDownload = null;
		this.isDownloading = false;
		this.scanInProgress = false;
		this.retryMap = {};  // key = filename, value = attemptNumber
	}


	// initialization function 
	init() {
		// start scan after initial boot delay
		setTimeout(() => {
			this.triggerDownloadScan();
		}, INITIAL_SCAN_DELAY_MS);

		// hook into new config updates
		eventHub.on('newNetworkDataProcessed', () => {
			this.triggerDownloadScan();
		});

		// log initialization
		logger.info(`Initializing Content Download Manager...`);

		// signal that this module has finished initializing
		eventHub.emit('moduleReady', 'ContentDownloadManager');
	}


	// triggerDownloadScan - adds missing content to queue
	triggerDownloadScan() {
		try {
			if (this.scanInProgress) return;
			this.scanInProgress = true;

            if (configManager.checkLogLevel('interval')) {
                logger.info(`Checking for new content to be downloaded at ${ new Date().toLocaleTimeString() }`);
            }

			// console.log(`Checking for new content to be downloaded at ${ new Date().toLocaleTimeString() }`);

			const scenes = configManager.getScenes();

			if (!fs.existsSync(OUTPUT_DIR)) {
				fs.mkdirSync(OUTPUT_DIR, { recursive: true });
			}

			for (const scene of scenes ?? []) {
				if (!scene || !(scene.render_version > 0)) continue;

				try {
					const filename = `${scene.id}-${scene.render_version}.mp4`;
					const filePath = path.join(OUTPUT_DIR, filename);
					const downloadUrl = `${CONTENT_DOWNLOAD_URL}${scene.id}/${filename}`;

					const alreadyQueued = this.queue.find(q => q.filename === filename);
					const currentlyDownloading = this.activeDownload?.filename === filename;

					if (!fs.existsSync(filePath) && !alreadyQueued && !currentlyDownloading) {
						this.queue.push({
							sceneId: scene.id,
							renderVersion: scene.render_version,
							contentType: 'video',
							filename: filename,
							url: downloadUrl,
							path: filePath,
							attemptNumber: 1
						});
					}
				} catch (err) {
					logger.error(`Error evaluating content for scene ${scene?.id}: ${err.message}`);
				}
			}

			this.scanInProgress = false;

			if (!this.isDownloading && this.queue.length > 0) {
				this.startQueueProcessing();
			}
		} catch (error) {
			logger.error(`Error during download scan: ${error.message}`);
			this.scanInProgress = false;
		}
	}


	// startQueueProcessing - handles sequential downloads
	startQueueProcessing() {
		if (this.isDownloading || this.queue.length === 0) {
			return;
		}

		const nextItem = this.queue.shift();
		this.activeDownload = nextItem;
		this.isDownloading = true;

		this.downloadFile(nextItem)
			.then(() => {
				this.isDownloading = false;
				this.activeDownload = null;
				if (this.queue.length > 0) {
					this.startQueueProcessing();
				} else {
					this.purgeOldFiles();
				}

				if (this.queue.length === 0 && !this.isDownloading) {
					eventHub.emit('allContentReady');
				}
			})
			.catch((err) => {
				logger.error(`Download failed for ${nextItem.filename}: ${err.message}`);
				nextItem.attemptNumber++;
				if (nextItem.attemptNumber <= MAX_RETRY_ATTEMPTS) {
					this.queue.push(nextItem);  // push to end of queue
					logger.warn(`Retrying ${nextItem.filename}, attempt ${nextItem.attemptNumber}`);
				}
				this.isDownloading = false;
				this.activeDownload = null;
				this.startQueueProcessing();
			});
	}


	// downloadFile - handles single download with timeout
	//
	// Rewritten 2026-09-04 (review H10). The previous version piped the
	// response into a write stream at the FINAL path and resolved on the
	// writer's 'finish'. Two things were wrong with that, and together they
	// wedged the queue for the life of the process:
	//   1. pipe() does not forward a source error to the destination. When
	//      the connection dropped or the 5-minute abort fired, the response
	//      stream errored, the writer never finished and never errored, and
	//      the promise never settled — so isDownloading stayed true and no
	//      later download (or purge) could ever start.
	//   2. The partial file sat at its final path, so every later scan saw
	//      it as present and complete. Device renders have no +faststart, so
	//      a truncated mp4 has no header at all and cannot play.
	// Now: download to a .part file; pipeline() settles on every outcome and
	// destroys both streams; the byte count is checked against Content-Length
	// when the server sends one; only then is the file renamed into place.
	// Anything else deletes the .part and rejects, and the next scan simply
	// queues the file again.
	async downloadFile(item) {
		const partPath = `${item.path}.part`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

		try {
			const response = await axios.get(item.url, {
				responseType: 'stream',
				signal: controller.signal,
			});

			const expectedBytes = Number(response.headers['content-length']);

			await pipeline(response.data, fs.createWriteStream(partPath));

			const writtenBytes = fs.statSync(partPath).size;

			if (Number.isFinite(expectedBytes) && expectedBytes > 0 && writtenBytes !== expectedBytes) {
				throw new Error(`short download: got ${writtenBytes} of ${expectedBytes} bytes`);
			}

			if (writtenBytes === 0) {
				throw new Error('empty download');
			}

			fs.renameSync(partPath, item.path);

			if (configManager.checkLogLevel('interval')) {
				logger.info(`Downloaded: ${item.filename} (${writtenBytes} bytes)`);
			}
		} catch (err) {
			try { fs.unlinkSync(partPath); } catch (_) { /* nothing to remove */ }
			throw err;
		} finally {
			clearTimeout(timeout);
		}
	}


	// purgeOldFiles - removes unused or outdated files from /content
	purgeOldFiles() {
		try {
			const scenes = configManager.getScenes();
			const validRenderMap = new Map();

			for (const scene of scenes ?? []) {
				validRenderMap.set(scene.id, scene.render_version);
			}

			const filesInContent = fs.readdirSync(OUTPUT_DIR);
			const deletedFiles = [];

			for (const file of filesInContent) {
				try {
					// A .part left behind by a crash mid-download (the normal
					// failure path already removes its own). Never the one being
					// written right now.
					if (file.endsWith('.part') && this.activeDownload?.filename !== file.slice(0, -5)) {
						fs.unlinkSync(path.join(OUTPUT_DIR, file));
						deletedFiles.push(file);
						continue;
					}

					const match = file.match(/(\d+)-(\d+)\.mp4$/);
					if (!match) continue;

					const sceneId = parseInt(match[1]);
					const renderVersion = parseInt(match[2]);

					if (!validRenderMap.has(sceneId) || validRenderMap.get(sceneId) !== renderVersion) {
						fs.unlinkSync(path.join(OUTPUT_DIR, file));
						deletedFiles.push(file);
					}
				} catch (err) {
					logger.error(`Error evaluating purge for ${file}: ${err.message}`);
				}
			}

			if (deletedFiles.length > 0) {
            	if (configManager.checkLogLevel('interval')) {
					logger.info(`Purged ${deletedFiles.length} unused files: ${deletedFiles.join(', ')}`);
				}
			} else {
            	if (configManager.checkLogLevel('interval')) {
					logger.info('No unused content to purge.');
				}
			}
		} catch (err) {
			logger.error(`Error during purge: ${err.message}`);
		}
	}
}



// create an instance
const contentDownloadManager = new ContentDownloadManager();

// export for use in other modules
export default contentDownloadManager;
