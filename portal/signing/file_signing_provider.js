'use strict';

const crypto = require('crypto');
const fs = require('fs');
const envResolver = require('../../lib/env_resolver');
const { SigningProvider } = require('./signing_provider');

const normalizePem = value => String(value || '').replace(/\\n/g, '\n');

const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
};

const canonicalJson = value => JSON.stringify(canonicalize(value));

class FileSigningProvider extends SigningProvider {
  constructor(options = {}) {
    super();
    this._privateKeyPem = null;
    this._publicKeyPem = null;

    if (options.privateKeyPath) {
      this._privateKeyPem = fs.readFileSync(options.privateKeyPath, 'utf8');
    } else if (options.privateKeyPem) {
      this._privateKeyPem = options.privateKeyPem;
    } else if (process.env.LICENSE_SIGNING_KEY_PATH) {
      this._privateKeyPem = fs.readFileSync(process.env.LICENSE_SIGNING_KEY_PATH, 'utf8');
    } else if (envResolver.resolve('LICENSE_PRIVATE_KEY')) {
      this._privateKeyPem = envResolver.resolve('LICENSE_PRIVATE_KEY');
    }

    if (options.publicKeyPath) {
      this._publicKeyPem = fs.readFileSync(options.publicKeyPath, 'utf8').trim();
    } else if (options.publicKeyPem) {
      this._publicKeyPem = options.publicKeyPem;
    } else if (process.env.LICENSE_PUBLIC_KEY_PATH) {
      this._publicKeyPem = fs.readFileSync(process.env.LICENSE_PUBLIC_KEY_PATH, 'utf8').trim();
    } else if (envResolver.resolve('LICENSE_PUBLIC_KEY')) {
      this._publicKeyPem = normalizePem(envResolver.resolve('LICENSE_PUBLIC_KEY'));
    }

    if (!this._privateKeyPem) {
      throw new Error('FileSigningProvider requires a private key (path or PEM)');
    }
  }

  async sign(payload) {
    const canonical = canonicalJson(payload);
    const signature = crypto
      .sign('RSA-SHA256', Buffer.from(canonical), normalizePem(this._privateKeyPem))
      .toString('base64');

    return {
      payload,
      algorithm: 'RSA-SHA256',
      signature,
    };
  }

  async getPublicKeyPem() {
    if (this._publicKeyPem) {
      return this._publicKeyPem;
    }

    const priv = crypto.createPrivateKey(normalizePem(this._privateKeyPem));
    const pub = crypto.createPublicKey(priv);
    return pub.export({ type: 'pkcs1', format: 'pem' });
  }

  getInfo() {
    return {
      type: 'file',
      algorithm: 'RSA-SHA256',
    };
  }

  toJSON() {
    return {
      type: 'file',
      algorithm: 'RSA-SHA256',
      hasPublicKey: !!this._publicKeyPem,
    };
  }
}

module.exports = { FileSigningProvider, canonicalJson };
