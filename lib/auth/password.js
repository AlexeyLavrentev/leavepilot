'use strict';

// ponytail: scrypt from Node's stdlib — per-user salt, no extra dependency.
// Stored format encodes the algorithm and its parameters so future upgrades
// can be detected:  scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>

const crypto = require('crypto');

const SCRYPT_PREFIX = 'scrypt';
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 };

function hashPassword(plain, params) {
  const cfg = Object.assign({}, DEFAULT_PARAMS, params || {});
  const salt = crypto.randomBytes(cfg.saltBytes);
  const derived = crypto.scryptSync(String(plain), salt, cfg.keylen, {
    N: cfg.N,
    r: cfg.r,
    p: cfg.p,
  });

  return [
    SCRYPT_PREFIX,
    cfg.N,
    cfg.r,
    cfg.p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

function isScryptHash(stored) {
  return typeof stored === 'string' && stored.indexOf(SCRYPT_PREFIX + '$') === 0;
}

function verifyPassword(plain, stored) {
  if (!isScryptHash(stored)) {
    return false;
  }

  const parts = stored.split('$');
  if (parts.length !== 6) {
    return false;
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');

  if (
    !salt.length
    || !expected.length
    || !Number.isFinite(N)
    || !Number.isFinite(r)
    || !Number.isFinite(p)
  ) {
    return false;
  }

  let derived;
  try {
    derived = crypto.scryptSync(String(plain), salt, expected.length, { N, r, p });
  } catch {
    return false;
  }

  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// A stored hash needs rehashing whenever it is not in the current scrypt format
// (i.e. a legacy unsalted MD5 hash produced by older releases).
function needsRehash(stored) {
  return !isScryptHash(stored);
}

module.exports = {
  SCRYPT_PREFIX,
  DEFAULT_PARAMS,
  hashPassword,
  verifyPassword,
  isScryptHash,
  needsRehash,
};
