// StatusTracker.mjs
// status tracking module for the Flair Node firmware
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the StatusTracker javascript object,
// which dynamically tracks the current OS-level system status and sends it to the network module



// import modules
import os from 'os';
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('StatusTracker');

import configManager from './ConfigManager.mjs';



// variables
const SAMPLE_INTERVAL = 15000;  // interval for how often to check system status (should be 15000ms)



// Define the StatusTracker class
class StatusTracker {

    // constructor
    constructor() {
        // minimum and maximum interval to send a status update
        this.sampleInterval = SAMPLE_INTERVAL;

        // emit an event that the statusTracker is initializing
        eventHub.emit('moduleStatus', { 
            name: 'StatusTracker', 
            status: 'initializing',
            data: '',
        });
    }


    // initialize the sampling process
    init() {
        setInterval(() => {
            // process system status
            this.processSystemStatus();
        }, this.sampleInterval);

        // run once immediately
        this.processSystemStatus();

        // signal that this module has finished initializing
        eventHub.emit('moduleReady', 'StatusTracker');
    }


    // process system status
    processSystemStatus() {
        // wrap the system status processing in a try catch, in case there's errors with os
        try {
            if (configManager.checkLogLevel('interval')) {
                logger.info(`Processing current system status at ${ new Date().toLocaleTimeString() }`);
            }

            // emit an event that the statusTracker is running
            eventHub.emit('moduleStatus', { 
                name: 'StatusTracker', 
                status: 'operational',
                data: '',
            });

            // create an object with the current system status in it
            const currentSystemStatus = {
                timestamp: new Date(),
                
                platform: os.platform(),
                architecture: os.arch(),
                hostname: os.hostname(),

                cpuCount: os.cpus().length,
                cpuUsage: os.loadavg().map(num => num.toFixed(2)),

                totalMemory: this.formatBytes(os.totalmem()),
                freeMemory: this.formatBytes(os.freemem()),
                usedMemory: this.formatBytes(os.totalmem() - os.freemem()),

                uptime: this.formatTime(os.uptime()),

                diskUsage: 'unknown',

                networkInterfaces: os.networkInterfaces(),
            };

            // TEMP log the current system status object
            // console.log('currentSystemStatus', currentSystemStatus);

            // console.log('network', currentSystemStatus.networkInterfaces);

            // emit an event that the current system status has been processed
            eventHub.emit('systemStatusUpdate', currentSystemStatus);
        } catch (error) {
            logger.error(`Error processing system status: ${error}`);

            // emit an event that we had an error
            eventHub.emit('moduleStatus', { 
                name: 'StatusTracker', 
                status: 'errored',
                data: `Error processing system status: ${error}`,
            });
        }
    }


    // getUptimeString - return the current formatted OS uptime, used for diagnostic dumps
    getUptimeString() {
        return this.formatTime(os.uptime());
    }


    // helper function to return a usable number of bytes
    formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }


    // helper function to format time
    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = Math.floor(seconds % 60);

        if (hours >= 24) {
            const days = Math.floor(hours / 24);
            const formattedDays = String(days).padStart(1, '0');
            const formattedHours = String(hours % 24).padStart(1, '0');
            const formattedMinutes = String(minutes).padStart(1, '0');
            const formattedSeconds = String(remainingSeconds).padStart(1, '0');
            return `${formattedDays}d ${formattedHours}h ${formattedMinutes}m ${formattedSeconds}s`;
        } else {
            const formattedHours = String(hours).padStart(1, '0');
            const formattedMinutes = String(minutes).padStart(1, '0');
            const formattedSeconds = String(remainingSeconds).padStart(1, '0');
            return `${formattedHours}h ${formattedMinutes}m ${formattedSeconds}s`;
        }
    }
}



// Create an instance of StatusTracker
const statusTracker = new StatusTracker();

// Export the statusTracker instance for use in other modules
export default statusTracker;
