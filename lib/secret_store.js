'use strict';

// Encryption-at-rest for secrets stored in the database (e.g. the SSO OIDC
// client secret inside Company.sso_auth_config). Authenticated encryption with
// AES-256-GCM.
//
// Stored format (versioned, base64 parts):
//   enc:v1:aes-256-gcm:<iv>:<tag>:<ciphertext>
//
// Backward compatibility: values WITHOUT the enc: prefix are treated as legacy
// plaintext and returned as-is by decryptSecret(); the next save re-writes them
// encrypted.
//
// Key material: TIMEOFF_SECRET_KEY if set, otherwise the app-wide crypto_secret
// (CRYPTO_SECRET, resolved through config). A domain-separated 32-byte key is
// derived via SHA-256 so this use is independent of other crypto_secret uses
// (e.g. password hashing). Losing the key makes encrypted values unrecoverable.

const crypto = require('crypto');
const config = require('./config');
const envResolver = require('./env_resolver');

const PREFIX = 'enc:v1:aes-256-gcm:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_LABEL = 'timeoff-core-secret-store:v1';

function getRawKeyMaterial() {
  return envResolver.resolve('SECRET_KEY')
    || config.get('crypto_secret')
    || process.env.CRYPTO_SECRET
    || '';
}

function deriveKey() {
  const raw = getRawKeyMaterial();

  if (!raw) {
    throw new Error('Secret encryption key is not configured (set CRYPTO_SECRET or TIMEOFF_SECRET_KEY)');
  }

  return crypto.createHash('sha256').update(KEY_LABEL + ':' + raw).digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.indexOf(PREFIX) === 0;
}

function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return plaintext;
  }

  const key = deriveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return PREFIX
    + iv.toString('base64') + ':'
    + tag.toString('base64') + ':'
    + ciphertext.toString('base64');
}

function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === '') {
    return stored;
  }

  // Legacy plaintext stored before encryption-at-rest was introduced.
  if (!isEncrypted(stored)) {
    return stored;
  }

  const parts = stored.slice(PREFIX.length).split(':');

  if (parts.length !== 3) {
    throw new Error('Failed to decrypt secret: malformed payload');
  }

  try {
    const key = deriveKey();
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Never leak the stored value or key material in the error.
    throw new Error('Failed to decrypt secret: authentication failed or wrong key');
  }
}

module.exports = {
  PREFIX,
  isEncrypted,
  encryptSecret,
  decryptSecret,
};
