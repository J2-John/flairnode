#!/usr/bin/env bash

# Flair Kiosk start script!

echo "Starting Chromium test kiosk..."
sleep 3;

chromium \
        --kiosk file:///home/user/flairnode/render.html \
        --noerrdialogs \
        --disable-infobars \
        --disable-session-crashed-bubble \
        --no-first-run \
        --disable-features=PointerLock \
        --disable-translate \
        --disable-component-update \
        --disable-background-networking \
        --disable-sync \
        --metrics-recording-only \
        --no-service-autorun \
        --autoplay-policy=no-user-gesture-required \
        --user-data-dir="$HOME/.flair-chrome-test"