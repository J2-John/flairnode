// CanvasDimensions.mjs
// shared canvas-dimension calculation for the Flair Node firmware
// copyright 2025 Drew Shipps, J Squared Systems


// this module exports a single getCanvasDimensions() function — the bounding
// box of all zones in the current wall type's canvas, same calculation as
// RenderSceneWithPuppeteer.php's canvasDimensions(). Extracted out of
// PlaybackController so TriggerEngine can compute the same "full canvas"
// fallback rect without duplicating the calculation or importing
// PlaybackController (which would create a circular import, since
// PlaybackController calls into TriggerEngine).


// import modules
import configManager from './ConfigManager.mjs';


// used only when wall type/canvas is missing — mirrors render.html's fixed body size
const FALLBACK_CANVAS_WIDTH = 1920;
const FALLBACK_CANVAS_HEIGHT = 1080;


// getCanvasDimensions - bounding box of all zones in the wall type's canvas,
// same calculation as RenderSceneWithPuppeteer.php's canvasDimensions()
export function getCanvasDimensions() {
	const zones = configManager.getWallType()?.canvas?.zones;

	if (!Array.isArray(zones) || zones.length === 0) {
		return { width: FALLBACK_CANVAS_WIDTH, height: FALLBACK_CANVAS_HEIGHT };
	}

	let width = 0;
	let height = 0;

	for (const zone of zones) {
		width = Math.max(width, (zone.x ?? 0) + (zone.width ?? 0));
		height = Math.max(height, (zone.y ?? 0) + (zone.height ?? 0));
	}

	// dimensions must be even, same constraint as the PHP side
	if (width % 2 !== 0) width += 1;
	if (height % 2 !== 0) height += 1;

	return { width, height };
}
