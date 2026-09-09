'use strict';

const fs = require('fs');
const path = require('path');
const {TextDecoder} = require('util');
const redact = require('../util/diagnostic_text');

// Resource ceilings, not performance claims: the inspected historical bundle
// without Chrome contains 535 files / 2.2 MB, largest file 46 KB. Unknown binary
// attachments require review; they must never be silently certified as safe.
const LIMITS = Object.freeze({entries: 4096, depth: 16, fileBytes: 1024 * 1024, totalBytes: 64 * 1024 * 1024, jsonDepth: 32});
const requireTrue = (condition, message) => { if (!condition) { throw new Error(message); } };
// classTokens is the existing bounded DOM class-list field, not an auth token.
const sensitiveKey = key => key !== 'classTokens' && redact(`${key}=x`) !== `${key}=x`;

function checkText(text) {
  // Text evidence may contain tabs/newlines, but not binary or terminal controls.
  // eslint-disable-next-line no-control-regex
  requireTrue(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), 'Unsupported control bytes in evidence');
  requireTrue(!/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/.test(text), 'Unredacted credential in evidence');
  requireTrue(!/\b(?:sentinel-json-secret|stream-output-sentinel|sentinel-security-audit|sentinel-secret-security-audit)\b/.test(text), 'Unredacted sentinel in evidence');
  // Use the producer's policy. Already-redacted lines remain valid, while a
  // credential marker with an unsuppressed suffix requires review. This is not
  // a universal secret detector or a substitute for trusted run provenance.
  for (const line of text.split(/\r?\n/)) {
    // SARIF descriptions and SQL comments discuss "Bearer token" in prose.
    // Bare auth literals count at a value/line boundary, not in a sentence;
    // credential assignments are still checked anywhere by the shared policy.
    const candidate = line.replace(/\b(?:Bearer|Basic)\s+\S+/gi, (match, offset) =>
      /(?:^\s*|[:=]\s*)$/.test(line.slice(0, offset)) ? match : 'auth-description');
    requireTrue(redact(candidate) === candidate, 'Unredacted credential in evidence');
  }
}

function checkJson(value, depth = 0) {
  requireTrue(depth <= LIMITS.jsonDepth, 'Evidence JSON nesting is too deep');
  if (typeof value === 'string') {
    checkText(value);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      checkText(key);
      if (sensitiveKey(key)) {
        requireTrue(item === null || item === '[REDACTED]', 'Unredacted credential field in evidence');
      }
      if (key === 'classTokens') {
        requireTrue(Array.isArray(item) && item.length <= 12 && item.every(token =>
          typeof token === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(token)
          && !/(authorization|cookie|password|secret|token|api[_-]?key|key)/i.test(token)), 'Invalid DOM class-list evidence');
      }
      checkJson(item, depth + 1);
    }
  }
}

function checkJsonText(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Malformed evidence JSON'); }
  checkJson(value);
  // JSON.parse keeps only the last duplicate property. Inspect all original
  // string tokens too, including escaped keys/values that parsing overwrites.
  const strings = /"(?:[^"\\]|\\[\s\S])*"/g;
  for (let match = strings.exec(text); match; match = strings.exec(text)) {
    const token = JSON.parse(match[0]);
    checkText(token);
    const rest = text.slice(strings.lastIndex);
    const assignment = /^\s*:\s*/.exec(rest);
    if (!assignment || !sensitiveKey(token)) { continue; }
    const rawValue = rest.slice(assignment[0].length);
    const literal = /^"(?:[^"\\]|\\[\s\S])*"/.exec(rawValue);
    requireTrue(/^null\s*[,}]/.test(rawValue) || literal && JSON.parse(literal[0]) === '[REDACTED]', 'Unredacted credential field in evidence');
  }
}

function readBounded(file, expectedStat) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    requireTrue(stat.isFile() && stat.nlink === 1 && stat.ino === expectedStat.ino && stat.dev === expectedStat.dev && stat.size === expectedStat.size, 'Evidence changed while opening');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    let count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) {
      size += count;
    }
    requireTrue(size === stat.size && fs.fstatSync(fd).mtimeMs === stat.mtimeMs, 'Evidence changed while reading');
    return buffer.subarray(0, size);
  } finally {
    fs.closeSync(fd);
  }
}

function validateArtifactBundle(directory) {
  let entries = 0;
  let totalBytes = 0;
  const decoder = new TextDecoder('utf-8', {fatal: true});
  function visit(current, depth) {
    requireTrue(depth <= LIMITS.depth, 'Evidence nesting is too deep');
    // opendir bounds allocation even when an untrusted directory has far more
    // entries than the accepted bundle limit.
    const handle = fs.opendirSync(current);
    try {
      for (let item = handle.readSync(); item; item = handle.readSync()) {
        requireTrue(++entries <= LIMITS.entries, 'Too many evidence entries');
        checkText(item.name);
        const file = path.join(current, item.name);
        const stat = fs.lstatSync(file);
        requireTrue(!stat.isSymbolicLink(), 'Evidence symlinks are not allowed');
        if (stat.isDirectory()) {
          visit(file, depth + 1);
          continue;
        }
        requireTrue(stat.isFile() && stat.nlink === 1, 'Evidence must contain only regular, unlinked files');
        totalBytes += stat.size;
        requireTrue(stat.size <= LIMITS.fileBytes && totalBytes <= LIMITS.totalBytes, 'Evidence byte limit exceeded');
        const extension = path.extname(item.name);
        requireTrue(['.json', '.sarif', '.log', '.txt', '.sql'].includes(extension), 'Unsupported evidence file type');
        const text = decoder.decode(readBounded(file, stat));
        if (extension === '.json' || extension === '.sarif') {
          checkJsonText(text);
        } else {
          checkText(text);
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  visit(directory, 0);
}

module.exports = {validateArtifactBundle, LIMITS};
