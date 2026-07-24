// IdManager.mjs
// ID management module for the FlairNode firmware
// copyright 2025 Drew Shipps, J Squared Systems


// this module creates a single instance of the IdManager javascript object,
// which provides the device ID and serial number for all other modules



// import modules
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import eventHub from './EventHub.mjs';

import Logger from './Logger.mjs';
const logger = new Logger('IDManager');



// variables

// id.json lives ONE DIRECTORY ABOVE this file, regardless of process.cwd() —
// resolved from this module's own location (import.meta.url), not the old
// '../' (relative to whatever directory the process happened to be launched
// from, which broke unless FlairNode was started with cwd === this
// directory). Deliberately outside the flairnode/ directory itself: a git
// pull/clean of the app directory must never be able to wipe device
// identity. ProvisioningManager.mjs writes this same path on first boot;
// exported so it stays the single source of truth for both modules.
export const ID_JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'id.json');

const VERBOSE_LOGGING = false;
const LAPTOP_MODE = (process.platform == 'darwin');



// Define the IdManager class to handle everything about the device's configuration
class IdManager {

	// constructor
	constructor() {
		// create variables
		this.id = 0;
		this.serialnumber = 'unknown!';
		this.securitycode = null;

		// hold the file path for the id.json file
		this.filePath = ID_JSON_PATH;
	}


	// initialization function
	init() {
		this.loadFromFile();

		// signal that this module has finished initializing
		eventHub.emit('moduleReady', 'IdManager');
	}


	// load ID from file
	loadFromFile() {
		// try to load the ID data from the saved JSON file
		try {
			// load the raw data as a string from the file at this path
			const rawData = fs.readFileSync(this.filePath);

			// parse JSON data
			const parsedData = JSON.parse(rawData);

			// replace current config with the data from the file
			this.id = parseInt(parsedData.device_id);
			this.serialnumber = parsedData.serialnumber;

			// security_code is the claim PIN ProvisioningManager wrote alongside
			// device_id/serialnumber — not present on hand-provisioned units per
			// the old runbook, so null is a normal, expected value here, not an
			// error condition.
			this.securitycode = parsedData.security_code ?? null;

			// log success!
			logger.info(`Successfully identified this unit with id ${this.id} and serial number ${this.serialnumber}`);
		} catch (error) {
			// log the error
			logger.error(`Error loading id.json file: ${error.message}`);

			// failover to default values
			this.id = 0;
			this.serialnumber = 'unknown!';
			this.securitycode = null;

			// if running on laptop, the failover values are different
			if (LAPTOP_MODE) {
				logger.warn(`Failed over to LAPTOP_MODE default values of ID 1 and SN FN-0000001!`);

				this.id = 1;
				this.serialnumber = 'FN-0000001';
			}
		}
	}

	
	// id
	getId() {
        const id = this.id;

        // if undefined then log that we have an error and return default of zero
        if (id === undefined) {
            logger.error(`Undefined id!`);
            return 0;
        }

        // if < 0 then log that we have an error and return default of zero
        if (id < 0) {
            logger.error(`Invalid id value (less than zero)!`);
            return 0;
        }

        // else return id
        return id;
	}


	// serial number
	getSerialNumber() {
        const serialnumber = this.serialnumber;

        // if undefined then log that we have an error and return default of zero
        if (serialnumber === undefined) {
            logger.error(`Undefined serial number!`);
            return 'unknown!';
        }

        // else return serialnumber
        return serialnumber;
	}


	// security code (claim PIN) - null on units provisioned before this field
	// existed, or hand-provisioned per the old runbook; callers must treat
	// null as "no code to show", not an error
	getSecurityCode() {
        return this.securitycode ?? null;
	}
}



// Create an instance of the IdManager and initialize it
const idManager = new IdManager();

// Export the idManager instance for use in other modules
export default idManager;