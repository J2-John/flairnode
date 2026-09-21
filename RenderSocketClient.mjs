// RenderSocketClient.mjs
// websocket transport layer for render.html communication
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the RenderSocketClient javascript object,
// which handles transport of commands to the frontend Chromium interface (render.html)



// import modules
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('RenderSocketClient');

import configManager from './ConfigManager.mjs';

import { WebSocketServer } from 'ws';

import fs from 'fs';
import path from 'path';



// variables
const WEBSOCKET_PORT = 9223;

// Where the latest render-health report is written for anything on this device
// that needs it without going through the cloud (the updater's watch loop, a
// technician in a shell). RAM, never the SD card: this is rewritten every five
// seconds and the boards boot from microSD (doctrine 2.7). First usable wins.
const HEALTH_DIR_CANDIDATES = ['/dev/shm', '/run/shm', '/tmp'];
const HEALTH_FILE_NAME = 'flairnode-render-health.json';

// The only keys accepted from the page, and their types. The page is ours, but
// this goes to the cloud and into a file other tools parse, so its shape is
// decided here rather than trusted.
const HEALTH_NUMBER_KEYS = [
	'page_age_ms', 'interval_ms', 'page_frames', 'video_frames',
	'videos_mounted', 'videos_playing', 'images_mounted',
];
const HEALTH_SCREENS = ['error', 'boot', 'identify', 'serial', 'content', 'zones', 'blank'];



// define the RenderSocketClient class
class RenderSocketClient {

	// constructor
	constructor() {
		// hold WebSocket server instance
		this.wss = null;

		// hold client socket
		this.clientSocket = null;

		// latest render-health report from the page, with when it arrived
		this.latestHealth = null;
		this.latestHealthReceivedAt = 0;

		// Second browsers turned away since this process started. Nonzero is the
		// signature of the 2026-08-18 field incident — two kiosks fighting over
		// the one render socket — which nothing reported at the time.
		this.rejectedClientCount = 0;

		// resolved on first write; null until then or if no candidate works
		this.healthFilePath = undefined;
	}


	// init function to start WebSocket server
	init() {
		// log initialization
		logger.info(`Starting WebSocket server on port ${WEBSOCKET_PORT}...`);

		// create the WebSocket server
		this.wss = new WebSocketServer({ port: WEBSOCKET_PORT });

		// handle incoming connections
		this.wss.on('connection', (ws, req) => {
			const clientAddress = req.socket.remoteAddress;

			// only allow a single client
			if (this.clientSocket) {
				this.rejectedClientCount++;
				logger.warn(`Rejected new WebSocket client from ${clientAddress} (already connected)`);
				ws.close(1000, 'Only one client allowed');
				return;
			}

			// accept client
			this.clientSocket = ws;
			logger.info(`Render client connected!! (clientAddress: ${clientAddress})`);

			// emit event
			eventHub.emit('renderClientConnected');

			// handle messages from the page. Render-health reports arrive every
			// five seconds and are handled WITHOUT logging — logging each one
			// would put twelve lines a minute into the cloud log per node.
			ws.on('message', (message) => {
				this.handleClientMessage(message);
			});

			// handle disconnect
			ws.on('close', () => {
				logger.warn(`Render client disconnected from ${clientAddress}`);
				this.clientSocket = null;

				// emit event
				eventHub.emit('renderClientDisconnected');
			});

			// handle errors
			ws.on('error', (err) => {
				logger.error(`WebSocket error: ${err.message}`);
			});
		});

		// handle server-level errors
		this.wss.on('error', (err) => {
			logger.error(`WebSocket server error: ${err.message}`);
		});

		// signal that this module has finished initializing
		eventHub.emit('moduleReady', 'RenderSocketClient');
	}


	// handle one message from the page. Never throws: this runs inside the
	// socket's event handler, and an exception here would take the handler down.
	handleClientMessage(message) {
		let parsed = null;

		try {
			parsed = JSON.parse(String(message));
		} catch (err) {
			parsed = null;
		}

		if (parsed && parsed.type === 'health' && parsed.data && typeof parsed.data === 'object') {
			this.recordHealth(parsed.data);
			return;
		}

		// Anything else keeps the old behaviour: logged, otherwise ignored.
		logger.info(`Received message from render client: ${message}`);
	}


	// keep the latest report, reduced to the known shape, and mirror it to RAM
	recordHealth(data) {
		const clean = {};

		if (typeof data.page_session === 'string') {
			clean.page_session = data.page_session.slice(0, 40);
		}

		for (const key of HEALTH_NUMBER_KEYS) {
			const value = data[key];
			if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
				clean[key] = Math.round(value);
			}
		}

		if (HEALTH_SCREENS.includes(data.screen)) {
			clean.screen = data.screen;
		}

		this.latestHealth = clean;
		this.latestHealthReceivedAt = Date.now();

		this.writeHealthFile();
	}


	// The latest report as it stands NOW, for the sync payload and the file.
	//
	// age_ms is computed at the moment of asking, not when the report arrived. A
	// frozen browser stops reporting; its last report stays here, and only its
	// growing age reveals that it is stale. Returns null until the page has
	// reported at least once since this process started.
	getRenderHealth() {
		if (!this.latestHealth) {
			return null;
		}

		return {
			...this.latestHealth,
			age_ms: Date.now() - this.latestHealthReceivedAt,
			client_connected: this.clientSocket !== null,
			rejected_clients: this.rejectedClientCount,
		};
	}


	// Atomic write: a reader never sees half a file. Failure is logged once and
	// never thrown — a missing health file must not disturb playback.
	writeHealthFile() {
		try {
			if (this.healthFilePath === undefined) {
				this.healthFilePath = null;

				for (const dir of HEALTH_DIR_CANDIDATES) {
					try {
						fs.accessSync(dir, fs.constants.W_OK);
						this.healthFilePath = path.join(dir, HEALTH_FILE_NAME);
						break;
					} catch (err) {
						// try the next candidate
					}
				}

				if (this.healthFilePath === null) {
					logger.warn('No writable RAM directory for the render-health file; health goes to the cloud only.');
				}
			}

			if (this.healthFilePath === null) {
				return;
			}

			const tmpPath = `${this.healthFilePath}.tmp`;
			fs.writeFileSync(tmpPath, JSON.stringify(this.getRenderHealth()));
			fs.renameSync(tmpPath, this.healthFilePath);
		} catch (err) {
			if (!this.healthFileErrorLogged) {
				logger.warn(`Could not write the render-health file: ${err.message}`);
				this.healthFileErrorLogged = true;
			}
		}
	}


	// send function - send JSON command to connected client
	send(command, data = {}) {
		// check if client is connected
		if (!this.clientSocket || this.clientSocket.readyState !== this.clientSocket.OPEN) {
			logger.warn(`Tried to send command "${command}" but no client is connected`);
			return false;
		}

		// create payload
		const payload = {
			command,
			data,
		};

		// try to send
		try {
			this.clientSocket.send(JSON.stringify(payload));

            if (configManager.checkLogLevel('detail')) {
				logger.info(`Sent command to render client: ${command}`);
			}

			return true;
		} catch (err) {
			logger.error(`Failed to send command "${command}" to client: ${err.message}`);

			return false;
		}
	}


	// isConnected function - returns boolean for connection status
	isConnected() {
		return !!this.clientSocket && this.clientSocket.readyState === this.clientSocket.OPEN;
	}

}



// create and export an instance
const renderSocketClient = new RenderSocketClient();

export default renderSocketClient;
