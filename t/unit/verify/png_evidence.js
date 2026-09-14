'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {deflateSync} = require('zlib');
const {expect} = require('chai');
const {validateArtifactBundle} = require('../../../lib/verify/artifact_bundle');
const {png, chunk, signature} = require('../../fixtures/verify/png');

describe('bounded PNG diagnostic evidence', () => {
  let directory;
  const validate = bytes => {
    fs.writeFileSync(path.join(directory, 'screenshot.png'), bytes);
    return () => validateArtifactBundle(directory);
  };
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-png-')); });
  afterEach(() => fs.rmSync(directory, {recursive: true, force: true}));

  for (const color of [2, 6]) {
    it(`accepts intact static 8-bit color type ${color} with multiple IDAT chunks`, () => {
      const bytes = png({color, split: true});
      expect(validate(bytes)).not.to.throw();
      expect(fs.readFileSync(path.join(directory, 'screenshot.png')).equals(bytes)).to.equal(true);
    });
  }

  for (const [name, bytes] of [
    ['renamed text', () => Buffer.from('password=sentinel-security-audit')],
    ['signature only', () => signature],
    ['truncated chunk', () => png().subarray(0, -1)],
    ['oversized chunk length', () => { const b = png(); b.writeUInt32BE(0xffffffff, 8); return b; }],
    ['bad CRC', () => { const b = png(); b[29] ^= 1; return b; }],
    ['zero width', () => png({width: 0})],
    ['oversized dimension', () => png({width: 4097, compressed: deflateSync(Buffer.from([0]))})],
    ['excessive decoded pixels', () => png({width: 4096, height: 4096, compressed: deflateSync(Buffer.from([0]))})],
    ['unsupported depth', () => png({depth: 16})],
    ['unsupported palette', () => png({color: 3})],
    ['unsupported compression method', () => png({compression: 1})],
    ['unsupported filter method', () => png({filter: 1})],
    ['interlacing', () => png({interlace: 1})],
    ['text metadata', () => png({extra: [chunk('tEXt', Buffer.from('password\0sentinel-security-audit'))]})],
    ['compressed text metadata', () => png({extra: [chunk('zTXt', deflateSync(Buffer.from('password=sentinel-security-audit')))]})],
    ['unknown chunk', () => png({extra: [chunk('zzZZ')]})],
    ['too many chunks', () => png({extra: Array.from({length: 1024}, () => chunk('IDAT'))})],
    ['short IHDR', () => Buffer.concat([signature, chunk('IHDR', Buffer.alloc(12)), png().subarray(33)])],
    ['duplicate IHDR', () => { const b = png(); return Buffer.concat([b.subarray(0, 33), b.subarray(8)]); }],
    ['IDAT before IHDR', () => Buffer.concat([signature, chunk('IDAT', deflateSync(Buffer.alloc(14))), png().subarray(8)])],
    ['missing IDAT', () => Buffer.concat([png().subarray(0, 33), chunk('IEND')])],
    ['missing IEND', () => png().subarray(0, -12)],
    ['nonempty IEND', () => Buffer.concat([png().subarray(0, -12), chunk('IEND', Buffer.from('x'))])],
    ['trailing file bytes', () => Buffer.concat([png(), Buffer.from('password=sentinel-security-audit')])],
    ['trailing compressed bytes', () => png({compressed: Buffer.concat([deflateSync(Buffer.alloc(14)), Buffer.from('secret')])})],
    ['concatenated compressed streams', () => png({compressed: Buffer.concat([deflateSync(Buffer.alloc(14)), deflateSync(Buffer.alloc(14))])})],
    ['invalid compressed stream', () => png({compressed: Buffer.from('not zlib')})],
    ['truncated compressed stream', () => png({compressed: deflateSync(Buffer.alloc(14)).subarray(0, -1)})],
    ['short scanlines', () => png({raw: Buffer.alloc(13)})],
    ['decompression bomb', () => png({raw: Buffer.alloc(1024 * 1024)})],
    ['invalid filter byte', () => png({raw: Buffer.from([5, ...Array(13).fill(0)])})],
  ]) {
    it(`rejects ${name} without echoing image contents`, () => {
      expect(validate(bytes())).to.throw().with.property('message').that.does.not.include('sentinel-security-audit');
    });
  }

  it('accepts all five scanline filters and checks each row', () => {
    const raw = Buffer.alloc(35);
    for (let row = 0; row < 5; row++) { raw[row * 7] = row; }
    expect(validate(png({height: 5, raw}))).not.to.throw();
    raw[28] = 5;
    expect(validate(png({height: 5, raw}))).to.throw('Invalid PNG scanline filter');
  });

  it('bounds cumulative decompression work across individually valid files', () => {
    const bytes = png({width: 2048, height: 2047, color: 6});
    // Each image is just under 16 MiB decoded; the ninth exceeds 128 MiB.
    for (let n = 0; n < 9; n++) { fs.writeFileSync(path.join(directory, `${n}.png`), bytes); }
    expect(() => validateArtifactBundle(directory)).to.throw(/PNG.*limit/);
  });
});
