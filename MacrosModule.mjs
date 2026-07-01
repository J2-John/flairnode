// MacrosModule.mjs
// macro control module for the Flair Node firmware
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the MacrosModule javascript object,
// which handles the reboot and update controls for the device



// import modules
import { exec } from 'child_process';
import fs from 'fs';
import eventHub from './EventHub.mjs';
import renderSocketClient from './RenderSocketClient.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('MacrosModule');

import configManager from './ConfigManager.mjs';



// variables
const SAMPLE_INTERVAL = 15000;  // interval for how often to process macros (should be 15000ms)
const LAPTOP_MODE = (process.platform == 'darwin');
const MACROS_PROCESSING_TIMEOUT = 60000;  // should be 60000ms

const MACRO_ACTION_FILE_PATH = './lastMacroActioned.json';  // path to the file that tracks when reboot/update were last actioned
const MACRO_ACTION_GUARD_WINDOW = 300000;  // don't re-action reboot/update within this window (should be 300000ms / 5 min)



// Define the MacrosModule class
class MacrosModule {

    // constructor
    constructor() {
        // interval for processing macros
        this.sampleInterval = SAMPLE_INTERVAL;

        // variables
        this.rebootQueuedFromServer = false;
        this.reloadQueuedFromServer = false;
        this.updateQueuedFromServer = false;

        this.rebootCommandSuccess = false;
        this.reloadCommandSuccess = false;
        this.updateCommandSuccess = false;

        this.rebootCommandResults = '';
        this.reloadCommandResults = '';
        this.updateCommandResults = '';

        // emit an event that the macros module is operational
        eventHub.emit('moduleStatus', { 
            name: 'MacrosModule', 
            status: 'operational',
            data: '',
        });
    }


    // initialize the sampling process
    init() {
        setInterval(() => {
            // process macros
            this.processMacros();
        }, this.sampleInterval);
    }


    // process macros
    processMacros() {
        // log that we're now processing device macros
        if (configManager.checkLogLevel('interval')) {
            logger.info(`Processing device macros at ${ new Date().toLocaleTimeString() }`);
        }

        // get updated config from configManager
        this.getUpdatedConfig();


        // create a timeout Promise that will reject if it takes longer than 30 seconds
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Timeout: Macro execution took longer than ${MACROS_PROCESSING_TIMEOUT}ms`));
            }, MACROS_PROCESSING_TIMEOUT); // timout length
        });


        // run the two different macro functions as promises
        Promise.race([
            Promise.all([this.handleReboot(), this.handleReload(), this.handleUpdate()]), // race these two promises 
            timeoutPromise // with the timeout promise
        ])
        .then((results) => {
            // log success
            if (configManager.checkLogLevel('detail')) {
                logger.info(`Completed processing device macros!`);
            }

            // emit an event that the MacrosModule finished
            eventHub.emit('moduleStatus', { 
                name: 'MacrosModule', 
                status: 'operational',
                data: 'Completed processing device macros!',
            });

            // emit macros event, to send completed data back to server
            this.emitMacrosEvent();
        })
        .catch((error) => {
            // log the error
            logger.error(`Error processing device macros: ${error}`);

            // emit an event that we had an error
            eventHub.emit('moduleStatus', { 
                name: 'MacrosModule', 
                status: 'errored',
                data: `Error processing device macros: ${error}`,
            });

            // emit macros event back to server regardless
            this.emitMacrosEvent();
        });
    }


    // get updated config from configManager
    getUpdatedConfig() {
        this.rebootQueuedFromServer = configManager.getReboot();
        this.reloadQueuedFromServer = configManager.getReload();
        this.updateQueuedFromServer = configManager.getUpdate();
    }


    // check if the given action (reboot/update) was already actioned within the guard window,
    // to avoid re-triggering it on every sync cycle while the cloud still has the flag set
    wasRecentlyActioned(actionType) {
        try {
            // load the raw data as a string from the file at this path
            const rawData = fs.readFileSync(MACRO_ACTION_FILE_PATH);

            // parse JSON data
            const parsedData = JSON.parse(rawData);

            // pull the timestamp for this action type
            const lastActionedAt = parsedData[actionType];

            // if there's no timestamp recorded for this action, it hasn't been actioned recently
            if (!lastActionedAt) {
                return false;
            }

            // return whether the timestamp falls within the guard window
            return (Date.now() - lastActionedAt) < MACRO_ACTION_GUARD_WINDOW;
        } catch (error) {
            // file doesn't exist yet or is corrupt, so treat as not recently actioned
            return false;
        }
    }


    // record that the given action (reboot/update) was just actioned, so subsequent
    // sync cycles within the guard window know to skip it
    markActioned(actionType) {
        try {
            // start with whatever's already in the file, so we don't clobber the other action's timestamp
            let data = {};
            try {
                data = JSON.parse(fs.readFileSync(MACRO_ACTION_FILE_PATH));
            } catch (readError) {
                data = {};
            }

            // set the timestamp for this action type
            data[actionType] = Date.now();

            // write it back to the file
            fs.writeFileSync(MACRO_ACTION_FILE_PATH, JSON.stringify(data, null, 2));
        } catch (error) {
            // log the error, but don't block the action from proceeding
            logger.error(`Error saving ${actionType} action timestamp: ${error.message}`);
        }
    }


    // handle reboot command
    handleReboot() {
        // return a promise
        return new Promise((resolve, reject) => {
        
            // check if a reboot command has been queued from the server
            if (this.rebootQueuedFromServer == true) {

                // check if this reboot was already actioned recently, to avoid looping
                // if the cloud hasn't cleared the reboot flag yet
                if (this.wasRecentlyActioned('reboot')) {
                    // log that we're skipping
                    logger.warn(`Reboot already actioned recently, skipping to avoid a reboot loop.`);

                    // report success so the server sees it and (hopefully) clears the flag
                    this.rebootCommandSuccess = true;
                    this.rebootCommandResults = 'Reboot already actioned recently, skipped to avoid a loop.';

                    // resolve without re-actioning
                    resolve(this.rebootCommandResults);
                    return;
                }

                // record that we're actioning this reboot now, before executing it,
                // so we don't re-action it on the next sync cycle
                this.markActioned('reboot');

                // check if we're running on laptop or raspi
                if (!LAPTOP_MODE) {

                    // Command to schedule a restart in 1 minute
                    const command = 'sudo /usr/sbin/shutdown -r +1';

                    // Execute the command
                    exec(command, (error, stdout, stderr) => {
                        if (error) {
                            // set the rebootCommandSuccess variable to false, since the reboot failed
                            this.rebootCommandSuccess = false;

                            // set the rebootCommandResults variable to the error text
                            this.rebootCommandResults = error;

                            // log the error
                            logger.error(`Device reboot command failed with error: ${error}`);

                            // emit an event that we had an error
                            eventHub.emit('moduleStatus', { 
                                name: 'MacrosModule', 
                                status: 'errored',
                                data: `Device reboot command failed with error: ${error}`,
                            });

                            // resolve with the error text
                            resolve(this.rebootCommandResults);
                        } else {
                            // otherwise success, so set this.rebootCommandSuccess to true to indicate that the command was successful
                            this.rebootCommandSuccess = true;

                            // set the rebootCommandResults variable to the success output from console
                            if (stdout.length > 0) {
                                this.rebootCommandResults = stdout;
                            } else {
                                this.rebootCommandResults = stderr;
                            }

                            // log the success
                            logger.info(`Device reboot activated successfully with message: ${this.rebootCommandResults}`);

                            // emit a success event
                            eventHub.emit('moduleStatus', { 
                                name: 'MacrosModule', 
                                status: 'operational',
                                data: `Device reboot activated successfully with message: ${this.rebootCommandResults}`,
                            });

                            // resolve with the success text
                            resolve(`Device reboot activated successfully with message: ${this.rebootCommandResults}`);
                        }
                    });
                } else {
                    // log that we're on laptop mode
                    logger.warn(`Device reboot activated, but LAPTOP_MODE is true!`);

                    // since we're in laptop mode, we'll fake that we completed the reboot successfully
                    this.rebootCommandSuccess = true;
                    this.rebootCommandResults = '-- activated device reboot on laptop --';

                    // resolve with the success text
                    resolve(this.rebootCommandResults);
                }
            } else {
                // otherwise, we don't need to reboot, so ensure that rebootCommandResults is reset
                this.rebootCommandSuccess = false;
                this.rebootCommandResults = '';

                // resolve with a n/a message
                resolve('No reboot queued from server.');
            }
        });
    }


    // handle reload command
    handleReload() {
        // return a promise
        return new Promise((resolve, reject) => {
        
            // check if a reboot command has been queued from the server
            if (this.reloadQueuedFromServer == true) {

                // send reload_page to render client
                renderSocketClient.send('reload_page');

                // store results
                this.reloadCommandSuccess = true;
                this.reloadCommandResults = 'Reload command sent to render client.';

                // resolve with success
                resolve(this.reloadCommandResults);

            } else {
                // otherwise, we don't need to reboot, so ensure that rebootCommandResults is reset
                this.reloadCommandSuccess = false;
                this.reloadCommandResults = '';

                // resolve with a n/a message
                resolve('No reload queued from server.');
            }
        });
    }


    // handle update command
    handleUpdate() {
        // return a promise
        return new Promise((resolve, reject) => {

            // check if an update command has been queued from the server
            if (this.updateQueuedFromServer == true) {

                // check if this update was already actioned recently, to avoid looping
                // if the cloud hasn't cleared the update flag yet
                if (this.wasRecentlyActioned('update')) {
                    // log that we're skipping
                    logger.warn(`Update already actioned recently, skipping to avoid an update loop.`);

                    // report success so the server sees it and (hopefully) clears the flag
                    this.updateCommandSuccess = true;
                    this.updateCommandResults = 'Update already actioned recently, skipped to avoid a loop.';

                    // resolve without re-actioning
                    resolve(this.updateCommandResults);
                    return;
                }

                // record that we're actioning this update now, before executing it,
                // so we don't re-action it on the next sync cycle
                this.markActioned('update');

                // log that an update was queued
                logger.info('Update queued from server!');

                // Command to run the update
                const command = './update.sh';

                // Execute the command
                exec(command, (error, stdout, stderr) => {
                    if (error) {
                        // if there was an error executing the command

                        // set the updateCommandSuccess variable to false, since the update failed
                        this.updateCommandSuccess = false;

                        // set the updateCommandResults variable to the error text
                        this.updateCommandResults = `An error occurred during the update: ${error}`;

                        // log the error
                        logger.error(this.updateCommandResults);

                        // emit an event that we had an error
                        eventHub.emit('moduleStatus', { 
                            name: 'MacrosModule', 
                            status: 'errored',
                            data: this.updateCommandResults,
                        });

                        // resolve with the erorr text
                        resolve(this.updateCommandResults);
                    } else {
                        // otherwise success, so set this.updateCommandSuccess to true to indicate that the command was successful
                        this.updateCommandSuccess = true;

                        // get the results string from running the update
                        const lines = stdout.split('\n');
                        const results = lines[lines.length - 2].trim();

                        // set the rebootCommandResults variable to the success output from console
                        this.updateCommandResults = results;

                        // restart pm2 asyncronosly after 30 seconds.
                        // this is intended to give the network module a second to let the server know
                        // that the update was successful before restarting pm2
                        this.restartPm2Async();

                        // log the results as a success message
                        logger.info(`${results} Restarting pm2 in 30 seconds.`);

                        // emit a success event
                        eventHub.emit('moduleStatus', { 
                            name: 'MacrosModule', 
                            status: 'operational',
                            data: `${results} Restarting pm2 in 30 seconds.`,
                        });

                        // resolve with the success text
                        resolve(`${results} Restarting pm2 in 30 seconds.`);
                    }
                });
            } else {
                // otherwise, we don't need to update, so ensure that updateCommandResults is reset
                this.updateCommandSuccess = false;
                this.updateCommandResults = '';

                // resolve with a n/a message
                resolve('No update queued from server.');
            }
        });
    }



    async restartPm2Async() {
        // Command to async restart PM2 after 30 sec
        const command = 'sleep 30; pm2 restart all';

        // Execute the command
        exec(command, (error, stdout, stderr) => {
            if (error) {
                // log the error
                logger.error(`PM2 restart command failed with error: ${error}`);
            } else {
                // otherwise success

                // the problem here is that this code will never execute,
                // because if the pm2 restart all command is successful
                // then this code will be killed and restarted anyway

                // we'll go ahead and log the success, but this message will probably never be seen by anyone
                logger.info(`PM2 restart command success!`);
            }
        });
    }



    // emit a macros event to the system
    emitMacrosEvent() {
        // check if any macros had been queued from the server
        if (this.rebootQueuedFromServer || this.reloadQueuedFromServer || this.updateQueuedFromServer) {

            // log
            if (configManager.checkLogLevel('detail')) {
                logger.info(`At least one macro was queued by the server. Sending macros event with results back to server...`);
            }

            // setup the macros data object
            let macrosData = {
                rebootQueuedFromServer: this.rebootQueuedFromServer,
                rebootCommandSuccess: this.rebootCommandSuccess,
                rebootCommandResults: this.rebootCommandResults,

                reloadQueuedFromServer: this.reloadQueuedFromServer,
                reloadCommandSuccess: this.reloadCommandSuccess,
                reloadCommandResults: this.reloadCommandResults,

                updateQueuedFromServer: this.updateQueuedFromServer,
                updateCommandSuccess: this.updateCommandSuccess,
                updateCommandResults: this.updateCommandResults,
            }

            // log macrosData before sending to network module
            // console.log('macrosData', macrosData);

            // emit a network event to let the server know about the macros statuses
            eventHub.emit('macrosStatus', macrosData);
        }
    }
}



// Create an instance of MacrosModule
const macrosModule = new MacrosModule();

// Export the macrosModule instance for use in other modules
export default macrosModule;
