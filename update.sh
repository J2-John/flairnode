#!/bin/bash

# Variables
REPO_URL="https://github.com/J2-John/flairnode"
ZIP_FILE="flairnode.zip"
TMP_DIR="flairnode_tmp"

# Download the GitHub repository as a zip file
curl -L -o $ZIP_FILE "$REPO_URL/archive/refs/heads/main.zip"

# Unzip the downloaded file
unzip $ZIP_FILE -d $TMP_DIR

# Move the contents to the flairnode directory
# Assuming the unzipped folder is named flairnode-main
UNZIPPED_DIR="$TMP_DIR/flairnode-main"
TARGET_DIR="./"

# Create the target directory if it doesn't exist
mkdir -p $TARGET_DIR

# Use rsync to move the contents to the target directory
rsync -av --remove-source-files $UNZIPPED_DIR/ $TARGET_DIR/

# Clean up temporary files
rm -rf $ZIP_FILE $TMP_DIR

echo "Flair Node update.sh script v071625 complete!"
