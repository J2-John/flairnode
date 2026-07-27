#!/usr/bin/env node
// make-blank-cursor.mjs
// regenerates Assets/cursors/blank.xcursor — the fully transparent Xcursor
// image shipped with this repo
// copyright 2026 J Squared Systems


// This is a BUILD-TIME tool, not device code. It is committed for
// reproducibility/auditability only — no Pi ever runs it. The artifact it
// produces (Assets/cursors/blank.xcursor, ~11 KB) is committed alongside it
// and is what install-cursor-theme.sh copies onto a unit, which is why the
// units need no cursor-authoring toolchain (xcursorgen, ImageMagick, ...)
// installed.
//
// Regenerate with:  node bench/make-blank-cursor.mjs
//
// File format is the X.Org Xcursor format, per Xcursor(3) and the loader
// vendored by wlroots/libwayland-cursor (which is what labwc actually reads):
//
//   file header   magic CARD32 = 0x72756358 ("Xcur", LSBFirst)
//                 header CARD32 = bytes in this header = 16
//                 version CARD32 = 0x00010000 (major 1, minor 0)
//                 ntoc CARD32 = number of table-of-contents entries
//   toc entry     type CARD32, subtype CARD32, position CARD32
//                 (12 bytes each; position = ABSOLUTE byte offset of chunk)
//   image chunk   header CARD32 = bytes in this chunk header = 36
//                 type CARD32 = 0xfffd0002 (image)
//                 subtype CARD32 = nominal size
//                 version CARD32 = 1
//                 width, height, xhot, yhot, delay — CARD32 each
//                 pixels — width*height CARD32, packed ARGB
//
// Every 32-bit value is little-endian. Loader-side validation we must
// satisfy: width/height <= 0x7fff and not both zero, xhot <= width,
// yhot <= height, and each chunk header's type/subtype must match the
// values in its TOC entry.


import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';


const XCURSOR_MAGIC = 0x72756358;
const XCURSOR_FILE_HEADER_LEN = 16;
const XCURSOR_FILE_TOC_LEN = 12;
const XCURSOR_FILE_VERSION = (1 << 16) | 0;
const XCURSOR_IMAGE_TYPE = 0xfffd0002;
const XCURSOR_IMAGE_HEADER_LEN = 36;
const XCURSOR_IMAGE_VERSION = 1;

// Nominal sizes to ship. One would technically do — Xcursor picks the
// closest available size and a transparent image is transparent at any
// scale — but 24 (the XCURSOR_SIZE default) and 48 (what a hidpi/4K
// output asks for) cover both without a scaling step.
const SIZES = [24, 48];

const OUTPUT_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'Assets',
	'cursors',
	'blank.xcursor'
);


// buildImageChunk - one image chunk: 36-byte header followed by size*size
// fully transparent (0x00000000) ARGB pixels. Hotspot is 0,0 — arbitrary
// but must satisfy xhot <= width / yhot <= height, and there is no visible
// pixel for it to point at anyway.
function buildImageChunk(size) {
	const pixelBytes = size * size * 4;
	const chunk = Buffer.alloc(XCURSOR_IMAGE_HEADER_LEN + pixelBytes);  // alloc() zero-fills: every pixel is already fully transparent

	chunk.writeUInt32LE(XCURSOR_IMAGE_HEADER_LEN, 0);
	chunk.writeUInt32LE(XCURSOR_IMAGE_TYPE, 4);
	chunk.writeUInt32LE(size, 8);                     // subtype = nominal size
	chunk.writeUInt32LE(XCURSOR_IMAGE_VERSION, 12);
	chunk.writeUInt32LE(size, 16);                    // width
	chunk.writeUInt32LE(size, 20);                    // height
	chunk.writeUInt32LE(0, 24);                       // xhot
	chunk.writeUInt32LE(0, 28);                       // yhot
	chunk.writeUInt32LE(0, 32);                       // delay (0 = not animated)

	return chunk;
}


// buildCursorFile - assembles header + TOC + chunks. TOC positions are
// absolute file offsets, so they can only be computed once the header and
// TOC lengths are known — hence the two-pass shape here.
function buildCursorFile(sizes) {
	const chunks = sizes.map(buildImageChunk);

	const header = Buffer.alloc(XCURSOR_FILE_HEADER_LEN);
	header.writeUInt32LE(XCURSOR_MAGIC, 0);
	header.writeUInt32LE(XCURSOR_FILE_HEADER_LEN, 4);
	header.writeUInt32LE(XCURSOR_FILE_VERSION, 8);
	header.writeUInt32LE(sizes.length, 12);

	const toc = Buffer.alloc(XCURSOR_FILE_TOC_LEN * sizes.length);
	let position = XCURSOR_FILE_HEADER_LEN + toc.length;

	sizes.forEach((size, index) => {
		const offset = index * XCURSOR_FILE_TOC_LEN;

		toc.writeUInt32LE(XCURSOR_IMAGE_TYPE, offset);
		toc.writeUInt32LE(size, offset + 4);
		toc.writeUInt32LE(position, offset + 8);

		position += chunks[index].length;
	});

	return Buffer.concat([header, toc, ...chunks]);
}


// verifyCursorFile - reads the assembled buffer back the way a loader
// would and throws on any mismatch. Catches transcription slips (wrong
// offset, forgotten field, bad TOC position) before an 11 KB blob of
// mostly zeroes gets committed and shipped to a Pi, where "no cursor
// drawn" and "cursor file silently rejected" look identical from across
// the room.
function verifyCursorFile(buffer, sizes) {
	const assert = (condition, message) => {
		if (!condition) throw new Error(`blank.xcursor verification failed: ${message}`);
	};

	assert(buffer.readUInt32LE(0) === XCURSOR_MAGIC, 'bad magic');
	assert(buffer.readUInt32LE(4) === XCURSOR_FILE_HEADER_LEN, 'bad file header length');
	assert(buffer.readUInt32LE(8) === XCURSOR_FILE_VERSION, 'bad file version');

	const ntoc = buffer.readUInt32LE(12);
	assert(ntoc === sizes.length, `ntoc ${ntoc} != ${sizes.length} chunks`);

	for (let index = 0; index < ntoc; index++) {
		const tocOffset = XCURSOR_FILE_HEADER_LEN + (index * XCURSOR_FILE_TOC_LEN);

		const tocType = buffer.readUInt32LE(tocOffset);
		const tocSubtype = buffer.readUInt32LE(tocOffset + 4);
		const chunkOffset = buffer.readUInt32LE(tocOffset + 8);

		assert(tocType === XCURSOR_IMAGE_TYPE, `toc ${index}: not an image chunk`);
		assert(tocSubtype === sizes[index], `toc ${index}: subtype ${tocSubtype} != ${sizes[index]}`);
		assert(chunkOffset + XCURSOR_IMAGE_HEADER_LEN <= buffer.length, `toc ${index}: chunk offset past end of file`);

		// chunk header must agree with the toc entry that pointed here
		assert(buffer.readUInt32LE(chunkOffset) === XCURSOR_IMAGE_HEADER_LEN, `chunk ${index}: bad header length`);
		assert(buffer.readUInt32LE(chunkOffset + 4) === tocType, `chunk ${index}: type disagrees with toc`);
		assert(buffer.readUInt32LE(chunkOffset + 8) === tocSubtype, `chunk ${index}: subtype disagrees with toc`);
		assert(buffer.readUInt32LE(chunkOffset + 12) === XCURSOR_IMAGE_VERSION, `chunk ${index}: bad image version`);

		const width = buffer.readUInt32LE(chunkOffset + 16);
		const height = buffer.readUInt32LE(chunkOffset + 20);
		const xhot = buffer.readUInt32LE(chunkOffset + 24);
		const yhot = buffer.readUInt32LE(chunkOffset + 28);

		assert(width > 0 && width <= 0x7fff, `chunk ${index}: width ${width} out of range`);
		assert(height > 0 && height <= 0x7fff, `chunk ${index}: height ${height} out of range`);
		assert(xhot <= width && yhot <= height, `chunk ${index}: hotspot outside image`);

		const pixelStart = chunkOffset + XCURSOR_IMAGE_HEADER_LEN;
		const pixelBytes = width * height * 4;
		assert(pixelStart + pixelBytes <= buffer.length, `chunk ${index}: pixel data runs past end of file`);

		// the entire point of the artifact: every pixel fully transparent
		for (let pixel = 0; pixel < width * height; pixel++) {
			assert(buffer.readUInt32LE(pixelStart + (pixel * 4)) === 0x00000000, `chunk ${index}: pixel ${pixel} is not transparent`);
		}
	}

	assert(buffer.length === XCURSOR_FILE_HEADER_LEN + (ntoc * XCURSOR_FILE_TOC_LEN) + sizes.reduce((total, size) => total + XCURSOR_IMAGE_HEADER_LEN + (size * size * 4), 0), 'unexpected trailing bytes');
}


const cursorFile = buildCursorFile(SIZES);
verifyCursorFile(cursorFile, SIZES);

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, cursorFile);

console.log(`Wrote ${OUTPUT_PATH} (${cursorFile.length} bytes, nominal sizes ${SIZES.join(', ')}) — verified.`);
