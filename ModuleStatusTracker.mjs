// ModuleStatusTracker.mjs
// this single-instance module tracks statuses of other modules for the Flair Node firmware
// copyright 2024 Drew Shipps, J Squared Systems



// import modules
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('StatusTracker');

import configManager from './ConfigManager.mjs';



// variables
const SAMPLE_INTERVAL = 3000;  // interval for how often to check module statuses (should be 15000ms)
const SEND_TO_NETWORK_INTERVAL = 15000; // interval for how often to send module statuses to the server
const UNRESPONSIVE_THRESHOLD = 35;  // number of seconds before considering a module unresponsive



// Define the ModuleStatusTracker class
class ModuleStatusTracker {

    // constructor
    constructor() {
        // minimum and maximum interval to send a status update
        this.sampleInterval = SAMPLE_INTERVAL;

        // variable to hold on to each module's current status
        this.modules = [];

        // variable to hold the overall status
        this.overallStatus = 'initializing';

        // variable to hold the timestamp for the last sent packet
        // initial value needs to be current time minus send interval, so that the first packet will send
        this.lastStatusSentToNetworkTimestamp = (new Date() - SEND_TO_NETWORK_INTERVAL);

        // bind an event listener for each moduleStatus event
        eventHub.on('moduleStatus', this.moduleStatusListener.bind(this));
    }


    // initialization function
    init() {
        // start the interval for status sampling
        setInterval(() => {
            this.processAllModulesStatus();
        }, this.sampleInterval);

        // run once immediately
        this.processAllModulesStatus();

        // signal that this module has finished initializing
        eventHub.emit('moduleReady', 'ModuleStatusTracker');
    }


    // process the status of all modules
    processAllModulesStatus() {
        // wrap the system status processing in a try catch, in case there's errors with os
        try {
            if (configManager.checkLogLevel('interval')) {
                logger.info(`Processing current status of all modules at ${ new Date().toLocaleTimeString() }`);
            }

            // iterate over each module to check if any modules are unresponsive
            const currentTime = Date.now();
            this.modules.forEach(module => {
                const timeElapsed = (currentTime - module.timestamp) / 1000; // Time elapsed in seconds
                
                // check if this module is a one time status module
                // meaning that it's not going to be unresponsive because it only runs when needed
                let isAOneTimeStatusModule = module.oneTimeEvent === true ? true : false;

                if (timeElapsed > UNRESPONSIVE_THRESHOLD && !isAOneTimeStatusModule) {
                    module.status = 'unresponsive';
                    module.data = `Unresponsive for last ${this.timeAgoStringOnly(timeElapsed)}`;
                }
            });

            // copy the modules list, but without any oneTimeEvent properties
            const copyOfModulesToSend = this.modules.map(obj => {
                // Create a shallow copy of the object
                let newObj = { ...obj };
                
                // Remove the oneTimeEvent property if it exists
                if (newObj.hasOwnProperty('oneTimeEvent')) {
                    delete newObj.oneTimeEvent;
                }
                
                return newObj;
            });

            // process module statuses: update led panel, activate white backup, and set overall status
            this.processModuleStatuses();

            // create an object with each module's current status in it (for final network send)
            const currentModuleStatus = {
                timestamp: new Date(),
                overallStatus: this.overallStatus,
                modules: copyOfModulesToSend,
            };

            // TEMP log the current module status object
            // console.log('currentModuleStatus', currentModuleStatus);


            // calculate the difference between the current time and the last time we sent data to the network
            let difference = new Date() - this.lastStatusSentToNetworkTimestamp;

            // if the difference is greater than the interval, we need to send to network again
            if (difference > SEND_TO_NETWORK_INTERVAL) {
                // emit an event that the current system status has been processed (which should then be picked up by network module)
                eventHub.emit('moduleStatusUpdate', currentModuleStatus);

                // save the current time to the last sent timestamp
                this.lastStatusSentToNetworkTimestamp = new Date();
            }            
        } catch (error) {
            logger.error(`Error processing status of all modules: ${error}`);
        }
    }


    // processModuleStatuses - check on the status of important modules. set led panel, white backup, and overall status accordingly
    processModuleStatuses() {
        // check different modules
        // ...


        // if none are degraded and none are errored, then we can check network
        if (this.getModuleStatusByName('NetworkModule') == 'online') {

            // set the overall condition of the device to send to network
            this.overallStatus = 'online';

            return;
        }

        if (this.getModuleStatusByName('NetworkModule') == 'offline') {

            // set the overall condition of the device to send to network
            this.overallStatus = 'offline';

            return;
        }
    }


    // moduleStatusListener - handler for moduleStatus events
    moduleStatusListener(newModuleStatus) {
        // add a timestamp to the new object
        newModuleStatus.timestamp = new Date();

        // Find the index of the module with the given name
        const index = this.modules.findIndex(module => module.name === newModuleStatus.name);

        if (index !== -1) {
            // If found, update the existing entry  

            // check to make sure the existing one isnt an error, and we're within 1 second of it
            if (newModuleStatus.status == 'operational' 
                && (this.modules[index].status == 'degraded' || this.modules[index].status == 'errored')
                && ((newModuleStatus.timestamp - this.modules[index].timestamp) < 5000)) {
                // console.log('tried to add a new status that was operational within 5 sec of a non operational status');

                // console.log('new one was ', newModuleStatus)
                // console.log('old one was ', this.modules[index])
            } else {
                this.modules[index] = newModuleStatus;
            }
        } else {
            // If not found, add a new entry
            this.modules.push(newModuleStatus);
        }
    }


    // get a module's status by name
    getModuleStatusByName(name) {
        return this.findModuleByName(name)?.status ?? '';
    }


    // find a module by name
    findModuleByName(moduleName) {
        return this.modules.find(module => module.name === moduleName);
    }


    // getModulesSnapshot - return a snapshot copy of all module statuses, used for diagnostic dumps
    getModulesSnapshot() {
        return this.modules.map(module => ({ ...module }));
    }


    // timeAgo - gives a human readable, single unit of time
    timeAgoStringOnly(timeElapsed) {
        const timeDifference = timeElapsed; // Time elapsed in seconds

        const units = [
            // { name: 'year', seconds: 31536000 },
            // { name: 'month', seconds: 2592000 },
            // { name: 'week', seconds: 604800 },
            // { name: 'day', seconds: 86400 },
            { name: 'hour', seconds: 3600 },
            { name: 'minute', seconds: 60 },
            { name: 'second', seconds: 1 }
        ];

        for (const unit of units) {
            const interval = Math.floor(timeDifference / unit.seconds);
            if (interval >= 1) {
                return `${interval} ${unit.name}${interval > 1 ? 's' : ''}`;
            }
        }
    }
}



// Create an instance of ModuleStatusTracker
const moduleStatusTracker = new ModuleStatusTracker();

// Export the moduleStatusTracker instance for use in other modules
export default moduleStatusTracker;
