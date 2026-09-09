'use strict';

const {StringDecoder} = require('node:string_decoder');
const redact = require('../util/diagnostic_text');

const MAX_PENDING = 8192;
const MAX_LIVE_BYTES = 128 * 1024;
const MAX_TAIL = 4096;

module.exports = ({stdout, stderr}) => {
  const streams = {
    stdout: {decoder: new StringDecoder('utf8'), pending: '', write: stdout},
    stderr: {decoder: new StringDecoder('utf8'), pending: '', write: stderr},
  };
  let suppressed = false;
  let ended = false;
  let liveBytes = 0;
  let liveTruncated = false;
  let tail = '';

  function emit(stream, text) {
    if (!text) {return;}
    tail = (tail + text).slice(-MAX_TAIL);
    if (liveTruncated) {return;}
    if (liveBytes + Buffer.byteLength(text) > MAX_LIVE_BYTES) {
      stream.write('[Output truncated: console limit]\n');
      liveTruncated = true;
      return;
    }
    liveBytes += Buffer.byteLength(text);
    stream.write(text);
  }

  function flush(stream, final = false) {
    const raw = stream.pending;
    const safe = redact(raw);
    if (safe !== raw || safe.includes('[REDACTED]')) {
      // A credential may continue on later lines or the other pipe. Keep the
      // existing suffix-suppression policy sticky for this entire stage.
      suppressed = true;
      streams.stdout.pending = streams.stderr.pending = '';
      emit(stream, safe + (safe.endsWith('\n') ? '' : '\n'));
      emit(stream, '[Further child output suppressed after credential marker]\n');
      return;
    }
    if (raw.length > MAX_PENDING) {
      suppressed = true;
      streams.stdout.pending = streams.stderr.pending = '';
      emit(stream, '[Output truncated: unterminated or ambiguous line]\n');
      return;
    }
    if (final) {
      emit(stream, raw + (raw && !raw.endsWith('\n') ? '\n' : ''));
      stream.pending = '';
      return;
    }
    const boundary = raw.lastIndexOf('\n') + 1;
    if (!boundary) {return;}
    const prefix = raw.slice(0, boundary);
    // Reuse the policy to recognize a key/header awaiting its assignment on
    // the next line (e.g. "password\n=..."). Do not duplicate credential regexes.
    const probe = prefix + '=x';
    if (redact(probe) !== probe) {return;}
    stream.pending = raw.slice(boundary);
    emit(stream, prefix);
  }

  return {
    write(name, chunk) {
      if (ended || suppressed) {return;}
      const stream = streams[name];
      // Bound intermediate decoding even if a caller supplies one giant chunk.
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let offset = 0; offset < bytes.length && !suppressed; offset += 1024) {
        stream.pending += stream.decoder.write(bytes.subarray(offset, offset + 1024));
        flush(stream);
      }
    },
    end() {
      if (ended) {return;}
      ended = true;
      for (const stream of Object.values(streams)) {
        if (suppressed) {break;}
        stream.pending += stream.decoder.end();
        flush(stream, true);
      }
    },
    tail: () => tail,
  };
};
