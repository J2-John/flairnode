# FlairNode
 
Flair Node device firmware, version 1.0

---

# HOW TO SET UP A FLAIR NODE - SOAYAN MICRO PC VERSION

## 1. Initial Setup

These steps assume you've already done the inital setup steps in the assembly guide and you've reached the step that says to go to github and install the code by copying and pasting different code snippets into the terminal. Follow this guide to do so. 







## 2. FlairNode Source Code

### Download & Unzip

Install CURL with

`sudo apt install curl`

When prompted, type in sudo password, `jsquared22!`

Download the GitHub repository as a zip file

`curl -L -o flairnode.zip "https://github.com/DrewJSquared/flairnode/archive/refs/heads/main.zip"`

Unzip the downloaded file

`unzip flairnode.zip -d flairnode_tmp`

Move the contents to the flairnode directory

`rsync -av --remove-source-files flairnode_tmp/flairnode-main/ ./flairnode`

Clean up temporary files

`rm -rf flairnode.zip flairnode_tmp`


### Setup Device ID

Create id.json

`nano id.json`

Copy/Paste the following for id.json

```
{
  "device_id":1,
  "serialnumber":"FN-00100XX"
}
```

Change the device id number and serial number to match what's listed on the flairnode website for this device.

Then hit control x to save, select yes, then hit enter to close. 






## 3. NVM, Node, & PM2 Setup

### Install NVM
`cd ~/ && curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash `

Once this script finishes, close and reopen the terminal window in order for it to take effect. 

### Install NodeJS, NPM, & PM2
`nvm install 18 && npm install pm2 -g`

### Setup PM2 Processes
`cd ~/flairnode && pm2 start FlairNode.js && pm2 save && pm2 startup`

Once this command runs, the end of the output will include 3 lines that you need to copy and paste into the terminal in order for them to run. 






## 4. Chrome Kiosk Auto Launch

### Set Permissions
`cd ~/flairnode && chmod +x flairnode-kiosk.sh`

### Enable Desktop Autologin
The unit must boot straight to an auto-logged-in desktop session — the kiosk script only starts Chromium, it doesn't bring up the desktop itself.

`sudo raspi-config` → `1 System Options` → `S5 Boot / Auto Login` → `B4 Desktop Autologin`

Reboot for this to take effect.

### Arm Autostart
Run the kiosk script once by hand to install its autostart entry:

`./flairnode-kiosk.sh`

This drops a `~/.config/autostart/flairnode-kiosk.desktop` entry (XDG autostart — works the same regardless of desktop environment) that re-launches this same script every time the desktop session comes up. It's safe to re-run — the install step is skipped if the entry already exists. After this one-time run, a power-cycled unit comes back playing with zero human touch.





## 5. You're done! Go back to the assembly guide and keep going. 


