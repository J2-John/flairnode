// ContentDownloadManager.mjs
// content download manager for the Flair Node firmware
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the ContentDownloadManager javascript object,
// which handles file downloads and purging of unused content from the filesystem


// import modules
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('ContentDownloadManager');

import configManager from './ConfigManager.mjs';



// variables
const USE_LOCALHOST = false;  // for development only
const LAPTOP_MODE = (process.platform === 'darwin');

const CONTENT_DOWNLOAD_URL = (USE_LOCALHOST && LAPTOP_MODE)
	? 'http://flairled.test/storage/scene_renders/'
	: 'https://flairled.com/storage/scene_renders/';

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
			const contentList = configManager.getContent();

			if (!fs.existsSync(OUTPUT_DIR)) {
				fs.mkdirSync(OUTPUT_DIR, { recursive: true });
			}

			for (const scene of scenes ?? []) {
				if (!scene?.elements || scene.elements.length === 0) continue;

				for (const element of scene.elements) {
					try {
						const contentItem = contentList.find(c => c.id === element?.content_id);
						if (!contentItem) continue;

						const ext = contentItem.type === 'video' ? 'mp4' : 'jpg';
						const filename = `${scene.id}-${element.layer}-${scene.render_version}.${ext}`;
						const filePath = path.join(OUTPUT_DIR, filename);
						const downloadUrl = `${CONTENT_DOWNLOAD_URL}${scene.id}/${filename}`;

						const alreadyQueued = this.queue.find(q => q.filename === filename);
						const currentlyDownloading = this.activeDownload?.filename === filename;

						if (!fs.existsSync(filePath) && !alreadyQueued && !currentlyDownloading) {
							this.queue.push({
								sceneId: scene.id,
								layer: element.layer,
								renderVersion: scene.render_version,
								contentType: contentItem.type,
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
	downloadFile(item) {
		return new Promise((resolve, reject) => {
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

				axios.get(item.url, {
					responseType: 'stream',
					signal: controller.signal,
				})
				.then(response => {
					const writer = fs.createWriteStream(item.path);
					response.data.pipe(writer);

					writer.on('finish', () => {
						clearTimeout(timeout);

        				if (configManager.checkLogLevel('interval')) {
							logger.info(`Downloaded: ${item.filename}`);
						}

						// console.log(`Downloaded: ${item.filename}`);
							
						resolve();
					});

					writer.on('error', (err) => {
						clearTimeout(timeout);
						reject(err);
					});
				})
				.catch(err => {
					clearTimeout(timeout);
					reject(err);
				});
			} catch (err) {
				reject(err);
			}
		});
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
					const match = file.match(/(\d+)-\d+-(\d+)\.(jpg|mp4)$/);
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
