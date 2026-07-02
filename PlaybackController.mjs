// PlaybackController.mjs
// playback controller module for the FlairNode firmware
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the PlaybackController javascript object,
// which handles all video playback state, scheduling, and logic for the render client



// import modules
import eventHub from './EventHub.mjs';
import configManager from './ConfigManager.mjs';
import RenderSocketClient from './RenderSocketClient.mjs';
import idManager from './IdManager.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('PlaybackController');

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);



// variables
const INTERVAL_MS = 1000;  // how often to attempt processPlayback

const USE_LOCALHOST = false;  // for development only
const LAPTOP_MODE = (process.platform === 'darwin');

const CONTENT_DOWNLOAD_URL = (USE_LOCALHOST && LAPTOP_MODE)
	? 'http://flairled.test/storage/scene_renders/'
	: 'https://flairled.com/storage/scene_renders/';

const OUTPUT_DIR = path.join(__dirname, 'content');

// used only when wall type/canvas is missing — mirrors render.html's fixed body size
const FALLBACK_CANVAS_WIDTH = 1920;
const FALLBACK_CANVAS_HEIGHT = 1080;



// Define the PlaybackController class to handle playback logic
class PlaybackController {

	// constructor
	constructor() {
		// setup interval
		this.interval = INTERVAL_MS;
		this.lastRunTime = 0;
		this.isRunning = false;
		this.startTime = Date.now();

		this.renderClientIsReady = false;
		// this.contentIsReady = false;
		this.currentRoleId = null;

		// bind in the constructor
		this.handleNewSenseData = this.handleNewSenseData.bind(this);
		this.playSceneById = this.playSceneById.bind(this);
	}


	// initialization function 
	init() {
		// bind event from NetworkModule
		eventHub.on('newNetworkDataProcessed', () => {
			this.processPlayback();
		});

		// start interval
		setInterval(() => {
			const now = Date.now();

			if (!this.isRunning && now - this.lastRunTime >= this.interval) {
				this.processPlayback();
			}
		}, this.interval);


		// handle incoming sense data
		eventHub.on('receivedUDP', this.handleNewSenseData);

		// handle render client connected
		eventHub.on('renderClientConnected', () => {
			setTimeout(() => {
				this.renderClientIsReady = true;
				// logger.info('Render client is now ready to receive commands.');
			}, 1000);
		});

		// handle render client disconnected
		eventHub.on('renderClientDisconnected', () => {
			this.renderClientIsReady = false;
		});

		// handle contnet ready
		// eventHub.on('allContentReady', () => {
		// 	this.contentIsReady = true;
		// 	logger.info('Content downloads are ready.');
		// });



		// log initialization
		logger.info(`Initializing Playback Controller...`);

		// signal that this module has finished initializing
		eventHub.emit('moduleReady', 'PlaybackController');
	}


	// core playback handler
	processPlayback() {
		// mark as running
		this.isRunning = true;
		this.lastRunTime = Date.now();

		try {
			// check for identify mode
			const identifyMode = configManager.getIdentifyMode();
			const identifyTarget = configManager.getIdentifyTarget();
			if (identifyMode == true) {
				if (identifyTarget == true) {
					this.safeSend('identify_this_node', { 
	    				serial_number: idManager.getSerialNumber(), 
	    			});
				} else {
					this.safeSend('identify_not_this_node', { 
	    				serial_number: idManager.getSerialNumber(), 
	    			});
				}
			} else {
				// get wall type info
				const wallType = configManager.getWallType();

				if (!wallType) {
					logger.warn(`No wall type found, unable to show wall type zones.`);

					// Fallback: show serial number if nothing else is active
					this.safeSend('show_serial_number', { 
	    				serial_number: idManager.getSerialNumber(), 
	    			});

					return;
				}

				// check role
				const newRoleId = configManager.getRole()?.id ?? null;

				if (newRoleId !== this.currentRoleId) {
					logger.info(`Role changed: ${this.currentRoleId} -> ${newRoleId}`);
					this.currentRoleId = newRoleId;
					// this.contentIsReady = false; // force wait for new content
				}


				// load scene data
				const schedule = configManager.getSchedule();
				const now = new Date();
				const currentMinutes = now.getHours() * 60 + now.getMinutes();

				const activeSchedule = schedule?.find(entry =>
					currentMinutes >= entry.start && currentMinutes <= entry.end
				);

				let sceneId = activeSchedule?.scene_id ?? null;


				// load custom times data (priority)
				const customTimes = configManager.getCustomTimes() ?? [];
				// console.log(customTimes);

				const currentMonth = now.getMonth() + 1; // 1-12
				const currentDay = now.getDate();        // 1-31
				const currentMD = (currentMonth * 100) + currentDay;

				const activeCustom = customTimes.find(entry => {
					const startMD = (Number(entry.start_month) * 100) + Number(entry.start_day);
					const endMD = (Number(entry.end_month) * 100) + Number(entry.end_day);

					// Not supporting year wrap (e.g., Nov -> Feb). If it wraps, ignore for now.
					if (startMD > endMD) {
						return false;
					}

					const dateInRange = currentMD >= startMD && currentMD <= endMD;
					const timeInRange = currentMinutes >= entry.start && currentMinutes <= entry.end;

					return dateInRange && timeInRange;
				});

				if (activeCustom?.scene_id != null) {
					sceneId = activeCustom.scene_id;
				}

				// debug selected scene id
				// console.log('current scene id is ' + sceneId);


				// if scene exists then play it
				if (sceneId !== null) {
					this.playSceneById(sceneId, true, true);
				} else {
					// if no scene assigned show zones

					// get zones array from wallType.canvas.zones or fallback
					const zones = wallType.canvas?.zones ?? [];

					const currentTime = new Date().toLocaleTimeString();
					const uptime = this.getUptimeString();

					const enhancedZones = zones.map(zone => ({
						...zone,
						time_of_day: currentTime,
						uptime: uptime,
					}));

					this.safeSend('show_wall_type_zones_layout_with_time', { zones: enhancedZones });
				}
			}
		} catch (error) {
			logger.error(`Error in processPlayback: ${error.message}`);
		} finally {
			// mark done
			this.isRunning = false;
		}
	}



	// getCanvasDimensions - bounding box of all zones in the wall type's canvas,
	// same calculation as RenderSceneWithPuppeteer.php's canvasDimensions()
	getCanvasDimensions() {
		const zones = configManager.getWallType()?.canvas?.zones;

		if (!Array.isArray(zones) || zones.length === 0) {
			return { width: FALLBACK_CANVAS_WIDTH, height: FALLBACK_CANVAS_HEIGHT };
		}

		let width = 0;
		let height = 0;

		for (const zone of zones) {
			width = Math.max(width, (zone.x ?? 0) + (zone.width ?? 0));
			height = Math.max(height, (zone.y ?? 0) + (zone.height ?? 0));
		}

		// dimensions must be even, same constraint as the PHP side
		if (width % 2 !== 0) width += 1;
		if (height % 2 !== 0) height += 1;

		return { width, height };
	}


	// play scene by id - play a scene
	playSceneById(sceneId, repeat = true, clearElse = false, z_index = 17) {
		try {
			const scenes = configManager.getScenes();
			const scene = scenes.find(s => s.id === sceneId);

			if (!scene || !(scene.render_version > 0)) {
				logger.warn(`Scene ${sceneId} has not been rendered yet (render_version: ${scene?.render_version}).`);
				return;
			}

			if (clearElse) {
				const currentDomIds = [`${scene.id}-${scene.render_version}`];

				// include overrides (z_index < 17) — we'll assume those are the active ones
				const overrideSceneIds = configManager.getScenes()
					.filter(s => s.id !== sceneId) // don't re-include the current scene
					.map(s => `${s.id}-${s.render_version}`);

				const combinedDomIds = [...currentDomIds, ...overrideSceneIds];

				this.safeSend('clear_videos_except_dom_ids', {
					dom_ids: combinedDomIds,
				});
			}


			const { width: canvasWidth, height: canvasHeight } = this.getCanvasDimensions();

			this.safeSend('assert_video_is_playing', {
				file: `/content/${scene.id}-${scene.render_version}.mp4`,
				dom_id: `${scene.id}-${scene.render_version}`,
				x: 0,
				y: 0,
				width: canvasWidth,
				height: canvasHeight,
				type: 'video',
				loop: repeat,
				z_index: z_index,
			});
		} catch (err) {
			logger.error(`Failed to play scene ${sceneId}: ${err.message}`);
		}

	}




	// handleNewSenseData - function to handle the data packet received from the sense
	handleNewSenseData(object) {
		// wrap the processing logic in a try catch in case of errors
		try {
			// skip packets that are not from TYPE 1 devices (i.e. not from Attitude Sense units)
			if (object?.TYPE !== 1) {
				if (configManager.checkLogLevel('detail')) {
					logger.info(`Skipped non-sense UDP packet or invalid TYPE: ${object?.TYPE}`);
				}
				return;
			}

			// silently ignore packets from a Sense that isn't paired to this FlairNode
			// (if no serial is assigned yet, allow packets through unfiltered)
			const assignedSenseSerial = configManager.getAssignedSenseSerial();
			if (assignedSenseSerial && object?.SERIAL !== assignedSenseSerial) {
				return;
			}

			// validate the packet
			if (!this.validateSenseDataObject(object)) {
				return;
			}

    		// if detail log level, log that we just got a status packet
			if (configManager.checkLogLevel('detail')) {
    			logger.info(`New packet of TYPE=1 from sense ID: ${object.ID} with data ${object.DATA}`);
    		}

    		// console.log(`New packet from sense ID: ${object.ID} with data ${object.DATA}`);

            // process the data array from the sense's ports (string to array)
            const processedDataArrray = object.DATA.split(',').map(Number);

            const triggers = configManager.getTriggers();

			for (let i = 0; i < processedDataArrray.length; i++) {
				if (processedDataArrray[i] === 1) {
					const trigger = triggers?.find(t => t.port === i + 1);
					if (trigger?.scene_id != null) {
						const port = i + 1;
						const z = (port === 1) ? 0 : 17 - port; // port 1 = z0, port 2 = z15, ..., port 16 = z1

						this.playSceneById(trigger.scene_id, false, false, z);

						if (configManager.checkLogLevel('detail')) {
							logger.info(`Trigger on port ${i + 1} -> playing scene ${trigger.scene_id}`);
						}
					}
				}
			}

			// finished processing triggers

		} catch (error) {
    		// else log error
            logger.error(`Error processing sense data message: ${error}`);
        }
	}



	// validateSenseDataObject - validate the DATA field of a Sense TYPE=1 packet
	// DATA must be 19 comma-separated binary values: ports 0-14 = carwash inputs, ports 15-18 = relay/contact closure inputs
	validateSenseDataObject(object) {
		if (typeof object?.DATA !== 'string') {
			logger.warn(`Sense packet rejected: DATA is missing or not a string (ID: ${object?.ID})`);
			return false;
		}

		const parts = object.DATA.split(',');

		if (parts.length !== 19) {
			logger.warn(`Sense packet rejected: DATA has ${parts.length} values, expected 19 (ID: ${object?.ID})`);
			return false;
		}

		if (!parts.every(value => value === '0' || value === '1')) {
			logger.warn(`Sense packet rejected: DATA contains non-binary values (ID: ${object?.ID}): ${object.DATA}`);
			return false;
		}

		return true;
	}




	getUptimeString() {
		const seconds = Math.floor((Date.now() - this.startTime) / 1000);
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		return `${h}h ${m}m ${s}s`;
	}

	safeSend(command, data) {
		if (!this.renderClientIsReady) {
			logger.warn(`Render client not ready, skipping command: ${command}`);
			return;
		}

		// if (!this.contentIsReady) {
		// 	logger.warn(`Content not ready, skipping command: ${command}`);
		// 	return;
		// }

		RenderSocketClient.send(command, data);
	}

}



// Create an instance of the PlaybackController and initialize it
const playbackController = new PlaybackController();

// Export the playbackController instance for use in other modules
export default playbackController;
