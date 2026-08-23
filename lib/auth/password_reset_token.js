'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 60 * 60 * 1000;

const encode = value => Buffer.from(value, 'utf8').toString('base64url');
const decode = value => Buffer.from(value, 'base64url').toString('utf8');

const sign = ({encodedPayload, passwordHash, secret}) =>
  crypto
    .createHmac('sha256', secret)
    .update(`${encodedPayload}.${passwordHash}`)
    .digest('base64url');

const signaturesMatch = (actual, expected) => {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));

  return actualBuffer.length > 0
    && actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
};

const createPasswordResetToken = ({
  email,
  passwordHash,
  secret,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
}) => {
  if (!email || !passwordHash || !secret) {
    throw new Error('Email, password hash, and secret are required for a password reset token');
  }

  const encodedPayload = encode(JSON.stringify({
    version: 1,
    email: String(email).toLowerCase(),
    expiresAt: now + ttlMs,
  }));
  const signature = sign({encodedPayload, passwordHash, secret});

  return `${encodedPayload}.${signature}`;
};

const decodePasswordResetToken = token => {
  try {
    const [encodedPayload, signature, extra] = String(token || '').split('.');
    if (!encodedPayload || !signature || extra) {
      return null;
    }

    const payload = JSON.parse(decode(encodedPayload));
    if (
      payload.version !== 1
      || typeof payload.email !== 'string'
      || !Number.isFinite(payload.expiresAt)
    ) {
      return null;
    }

    return {
      encodedPayload,
      signature,
      payload,
    };
  } catch {
    return null;
  }
};

const verifyPasswordResetToken = ({
  token,
  passwordHash,
  secret,
  now = Date.now(),
}) => {
  const decoded = decodePasswordResetToken(token);
  if (!decoded || decoded.payload.expiresAt < now) {
    return null;
  }

  const expected = sign({
    encodedPayload: decoded.encodedPayload,
    passwordHash,
    secret,
  });

  return signaturesMatch(decoded.signature, expected)
    ? decoded.payload
    : null;
};

module.exports = {
  DEFAULT_TTL_MS,
  createPasswordResetToken,
  decodePasswordResetToken,
  verifyPasswordResetToken,
};
