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



// variables
const WEBSOCKET_PORT = 9223;



// define the RenderSocketClient class
class RenderSocketClient {

	// constructor
	constructor() {
		// hold WebSocket server instance
		this.wss = null;

		// hold client socket
		this.clientSocket = null;
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
				logger.warn(`Rejected new WebSocket client from ${clientAddress} (already connected)`);
				ws.close(1000, 'Only one client allowed');
				return;
			}

			// accept client
			this.clientSocket = ws;
			logger.info(`Render client connected!! (clientAddress: ${clientAddress})`);

			// emit event
			eventHub.emit('renderClientConnected');

			// handle messages (not used currently)
			ws.on('message', (message) => {
				logger.info(`Received message from render client: ${message}`);
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
