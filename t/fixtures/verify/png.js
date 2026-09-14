'use strict';

const {crc32, deflateSync} = require('zlib');

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
function chunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

function png({width = 2, height = 2, color = 2, depth = 8, compression = 0, filter = 0, interlace = 0, raw, compressed, extra = [], split = false} = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = color;
  header[10] = compression;
  header[11] = filter;
  header[12] = interlace;
  const data = compressed || deflateSync(raw || Buffer.alloc((width * (color === 6 ? 4 : 3) + 1) * height));
  const parts = split ? [data.subarray(0, 3), data.subarray(3)] : [data];
  return Buffer.concat([signature, chunk('IHDR', header), ...extra, ...parts.map(part => chunk('IDAT', part)), chunk('IEND')]);
}

module.exports = {png, chunk, signature};
