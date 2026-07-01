// FlairNode.js
// primary JS app for the Flair Node firmware
// copyright 2025 Drew Shipps, J Squared Systems




// ==================== IMPORT ====================
import Logger from './Logger.mjs';
const logger = new Logger('FlairNode');

import eventHub from './EventHub.mjs';

import idManager from './IdManager.mjs';
import configManager from './ConfigManager.mjs';
import networkModule from './NetworkModule.mjs';
import statusTracker from './StatusTracker.mjs';
import moduleStatusTracker from './ModuleStatusTracker.mjs';
import macrosModule from './MacrosModule.mjs';
import udpManager from './UDPManager.mjs';

import renderSocketClient from './RenderSocketClient.mjs';
import playbackController from './PlaybackController.mjs';
import contentDownloadManager from './ContentDownloadManager.mjs';



// ==================== INITIALIZATION SEQUENCE ====================

// initial logs
logger.info('Flair Node Device Firmware v1.0');
logger.info('Copyright 2025 Drew Shipps, J Squared Systems');
logger.info('System initializing at time ' + new Date());


// track which modules have reported that they've finished initializing, via the 'moduleReady' event
// each module emits this event as the last step of its own init() function
const readyModules = new Set();
eventHub.on('moduleReady', (name) => readyModules.add(name));

// whenReady - invoke fn() once every module named in deps has emitted 'moduleReady'
// (checks immediately in case the dependencies are already ready, then re-checks on each new moduleReady event)
function whenReady(deps, fn) {
	const check = () => {
		if (deps.every((dep) => readyModules.has(dep))) {
			eventHub.removeListener('moduleReady', check);
			fn();
		}
	};

	eventHub.on('moduleReady', check);
	check();
}


// these modules have no dependencies on other modules during init, so start them immediately
idManager.init();
configManager.init();
renderSocketClient.init();


// network module needs id and config data to be loaded before its request interval can run correctly
whenReady(['IdManager', 'ConfigManager'], () => {
	networkModule.init();
});


// these modules emit status events that network module must be listening for before they fire,
// so they wait for network module to have bound its eventHub listeners
whenReady(['NetworkModule'], () => {
	statusTracker.init();
	moduleStatusTracker.init();
	udpManager.init();
	contentDownloadManager.init();
});


// these modules send commands through the render socket client and listen for network module's events
whenReady(['NetworkModule', 'RenderSocketClient'], () => {
	playbackController.init();
	macrosModule.init();
});


// initialization sequence complete!
whenReady(
	['StatusTracker', 'ModuleStatusTracker', 'UDPManager', 'ContentDownloadManager', 'PlaybackController', 'MacrosModule'],
	() => {
		logger.info('Device initialization sequence complete!');
	}
);


