'use strict';

const {crc32, inflateSync} = require('zlib');

// A narrow screenshot contract, not a general-purpose PNG decoder. Chrome's
// retained diagnostics use only IHDR/IDAT/IEND. Reject all metadata rather than
// treating opaque text/ICC/EXIF payloads as secret-scanned evidence.
// Structure: https://www.w3.org/TR/png/#5DataRep
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const LIMITS = Object.freeze({dimension: 4096, decodedBytes: 16 * 1024 * 1024, totalDecodedBytes: 128 * 1024 * 1024, chunks: 1024});
const requireTrue = (condition, message) => { if (!condition) { throw new Error(message); } };

function validatePng(buffer, remainingBytes = LIMITS.totalDecodedBytes) {
  requireTrue(buffer.subarray(0, 8).equals(SIGNATURE), 'Invalid PNG signature');
  let offset = 8;
  let count = 0;
  let rowBytes = 0;
  let decodedBytes = 0;
  let ended = false;
  const parts = [];
  while (offset < buffer.length) {
    requireTrue(++count <= LIMITS.chunks, 'PNG chunk limit exceeded');
    requireTrue(offset + 12 <= buffer.length, 'Truncated PNG chunk');
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    requireTrue(end <= buffer.length, 'Truncated PNG data');
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, end - 4);
    requireTrue(crc32(buffer.subarray(offset + 4, end - 4)) === buffer.readUInt32BE(end - 4), 'Invalid PNG checksum');
    if (count === 1) {
      requireTrue(type === 'IHDR' && length === 13, 'Invalid PNG header');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      requireTrue(width > 0 && height > 0 && width <= LIMITS.dimension && height <= LIMITS.dimension, 'PNG dimension limit exceeded');
      requireTrue(data[8] === 8 && [2, 6].includes(data[9]) && data[10] === 0 && data[11] === 0 && data[12] === 0, 'Unsupported PNG encoding');
      rowBytes = 1 + width * (data[9] === 2 ? 3 : 4);
      decodedBytes = rowBytes * height;
      requireTrue(decodedBytes <= LIMITS.decodedBytes && decodedBytes <= remainingBytes, 'PNG decoded byte limit exceeded');
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      requireTrue(length === 0 && parts.length > 0 && end === buffer.length, 'Invalid PNG end or trailing bytes');
      ended = true;
    } else {
      throw new Error('Unsupported PNG chunk');
    }
    offset = end;
  }
  requireTrue(ended, 'Missing PNG end');
  const compressed = Buffer.concat(parts);
  let result;
  try {
    result = inflateSync(compressed, {maxOutputLength: decodedBytes, info: true});
  } catch {
    // Never echo opaque image contents or native decoder errors into CI logs.
    throw new Error('Invalid or oversized PNG compressed data');
  }
  requireTrue(result.buffer.length === decodedBytes && result.engine.bytesWritten === compressed.length, 'Invalid PNG image length or trailing compressed data');
  for (let row = 0; row < decodedBytes; row += rowBytes) {
    requireTrue(result.buffer[row] <= 4, 'Invalid PNG scanline filter');
  }
  // Pixel content is not OCR/secret-scanned. Acceptance still requires trusted
  // test/source provenance; CRC validates integrity, not authenticity.
  return decodedBytes;
}

module.exports = {validatePng, LIMITS};
