'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const expect = require('chai').expect;

const features = require('../../lib/features');
const { generateFingerprint } = require('../../lib/machine_fingerprint');
const { computeModuleHash, verifyModuleHash } = require('../../lib/module_integrity');
const { writeLicenseFile, readLicenseFile } = require('../../lib/license_storage');

describe('E2E: License Activation Integration', function() {
  const tmpDir = path.join(os.tmpdir(), 'leavepilot-e2e-' + Date.now());
  const licenseFile = path.join(tmpDir, 'license.json');
  const originalEnv = {};

  const envKeys = [
    'NODE_ENV',
    'LEAVEPILOT_LICENSE',
    'LEAVEPILOT_LICENSE_PUBLIC_KEY',
    'TIMEOFF_LICENSE',
    'TIMEOFF_LICENSE_PUBLIC_KEY',
  ];

  beforeEach(function() {
    envKeys.forEach(key => {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(function() {
    envKeys.forEach(key => {
      if (typeof originalEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });

  before(function() {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(function() {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) { /* ignore */ }
  });

  describe('Full activation flow: sign → verify → load', function() {
    it('completes online activation simulation', function() {
      const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });
      const publicKey = keyPair.publicKey.export({ type: 'pkcs1', format: 'pem' });
      const fingerprint = generateFingerprint();

      const payload = {
        schemaVersion: 2,
        licenseId: crypto.randomUUID(),
        customerName: 'E2E Test Corp',
        customerId: 'cust-e2e-001',
        features: ['sso_authentication', 'integration_api'],
        issuedAt: new Date().toISOString(),
        allowedMajorVersions: [3],
        plan: 'enterprise',
        machineFingerprint: fingerprint,
      };

      const signature = features.signLicensePayloadWithPrivateKey(payload, privateKey);

      process.env.NODE_ENV = 'production';
      process.env.LEAVEPILOT_LICENSE = JSON.stringify({
        payload,
        algorithm: 'RSA-SHA256',
        signature,
      });
      process.env.LEAVEPILOT_LICENSE_PUBLIC_KEY = publicKey;

      const status = features.getLicenseStatus();
      expect(status.valid).to.equal(true);
      expect(status.reason).to.equal('valid');
      expect(status.customer).to.equal('E2E Test Corp');
      expect(status.plan).to.equal('enterprise');
      expect(status.features).to.deep.equal(['sso_authentication', 'integration_api']);
      expect(status.machineFingerprint).to.equal(fingerprint);
    });

    it('rejects license with wrong machine fingerprint', function() {
      const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });
      const publicKey = keyPair.publicKey.export({ type: 'pkcs1', format: 'pem' });

      const payload = {
        schemaVersion: 2,
        licenseId: crypto.randomUUID(),
        customerName: 'E2E Test Corp',
        issuedAt: new Date().toISOString(),
        features: ['time_balance'],
        machineFingerprint: '0'.repeat(64),
      };

      const signature = features.signLicensePayloadWithPrivateKey(payload, privateKey);

      process.env.NODE_ENV = 'production';
      process.env.LEAVEPILOT_LICENSE = JSON.stringify({
        payload,
        algorithm: 'RSA-SHA256',
        signature,
      });
      process.env.LEAVEPILOT_LICENSE_PUBLIC_KEY = publicKey;

      const status = features.getLicenseStatus();
      expect(status.valid).to.equal(false);
      expect(status.reason).to.equal('machine_mismatch');
    });

    it('works without machine fingerprint (backward compatible)', function() {
      const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });
      const publicKey = keyPair.publicKey.export({ type: 'pkcs1', format: 'pem' });

      const payload = {
        schemaVersion: 2,
        licenseId: crypto.randomUUID(),
        customerName: 'E2E Legacy Corp',
        issuedAt: new Date().toISOString(),
        features: ['time_balance'],
      };

      const signature = features.signLicensePayloadWithPrivateKey(payload, privateKey);

      process.env.NODE_ENV = 'production';
      process.env.LEAVEPILOT_LICENSE = JSON.stringify({
        payload,
        algorithm: 'RSA-SHA256',
        signature,
      });
      process.env.LEAVEPILOT_LICENSE_PUBLIC_KEY = publicKey;

      const status = features.getLicenseStatus();
      expect(status.valid).to.equal(true);
      expect(status.machineFingerprint).to.be.null;
    });
  });

  describe('Offline activation flow', function() {
    it('generates offline request with machine fingerprint', function() {
      const fingerprint = generateFingerprint();

      const request = {
        type: 'leavepilot-offline-activation-request',
        version: 1,
        machineId: fingerprint,
        timestamp: new Date().toISOString(),
        hostname: os.hostname(),
      };

      const requestFile = path.join(tmpDir, 'request.json');
      fs.writeFileSync(requestFile, JSON.stringify(request, null, 2), 'utf8');

      const readRequest = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      expect(readRequest.type).to.equal('leavepilot-offline-activation-request');
      expect(readRequest.machineId).to.equal(fingerprint);
    });

    it('verifies license from offline file', function() {
      const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });
      const publicKey = keyPair.publicKey.export({ type: 'pkcs1', format: 'pem' });
      const fingerprint = generateFingerprint();

      const payload = {
        schemaVersion: 2,
        licenseId: crypto.randomUUID(),
        customerName: 'Offline Test Corp',
        issuedAt: new Date().toISOString(),
        features: ['sso_authentication'],
        machineFingerprint: fingerprint,
      };

      const envelope = {
        payload,
        algorithm: 'RSA-SHA256',
        signature: features.signLicensePayloadWithPrivateKey(payload, privateKey),
      };

      const licensePath = path.join(tmpDir, 'offline-license.json');
      fs.writeFileSync(licensePath, JSON.stringify(envelope, null, 2), 'utf8');

      // Set public key for verification
      process.env.LEAVEPILOT_LICENSE_PUBLIC_KEY = publicKey;

      const licenseContent = fs.readFileSync(licensePath, 'utf8').trim();
      const parsed = features.parseLicense(licenseContent);
      expect(parsed.reason).to.equal('parsed');

      const status = features.verifyLicenseEnvelope(parsed.parsed, 'file');
      expect(status.valid).to.equal(true);
      expect(status.payload.machineFingerprint).to.equal(fingerprint);
    });
  });

  describe('Module integrity', function() {
    it('computes and verifies module hash', function() {
      const modulePath = path.resolve(__dirname, '../../lib');
      const hash = computeModuleHash(modulePath);
      expect(hash).to.be.a('string');
      expect(hash).to.match(/^[0-9a-f]{64}$/);

      const result = verifyModuleHash(modulePath, hash);
      expect(result).to.be.null;

      const wrongResult = verifyModuleHash(modulePath, '0'.repeat(64));
      expect(wrongResult).to.equal('integrity_mismatch');
    });
  });

  describe('License file storage', function() {
    it('persists license across read/write cycle', function() {
      const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });
      const publicKey = keyPair.publicKey.export({ type: 'pkcs1', format: 'pem' });

      const payload = {
        schemaVersion: 2,
        licenseId: crypto.randomUUID(),
        customerName: 'Storage Test',
        issuedAt: new Date().toISOString(),
        features: ['integration_api'],
      };

      const envelope = {
        payload,
        algorithm: 'RSA-SHA256',
        signature: features.signLicensePayloadWithPrivateKey(payload, privateKey),
      };

      const config = require('../../lib/config');
      config.set('license_file', licenseFile);
      process.env.LEAVEPILOT_LICENSE_PUBLIC_KEY = publicKey;

      const written = writeLicenseFile(JSON.stringify(envelope));
      expect(written).to.equal(true);

      const result = readLicenseFile();
      expect(result.raw).to.not.be.null;
      expect(result.source).to.equal('file');

      const parsed = features.parseLicense(result.raw);
      expect(parsed.reason).to.equal('parsed');

      const verification = features.verifyLicenseEnvelope(parsed.parsed, 'file');
      expect(verification.valid).to.equal(true);
      expect(verification.payload.customerName).to.equal('Storage Test');

      config.set('license_file', undefined);
    });
  });

  describe('Hardcoded public key', function() {
    it('rejects license signed with wrong key when no env key', function() {
      const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });

      const payload = {
        schemaVersion: 2,
        licenseId: crypto.randomUUID(),
        customerName: 'Key Test',
        issuedAt: new Date().toISOString(),
        features: ['time_balance'],
      };

      const signature = features.signLicensePayloadWithPrivateKey(payload, privateKey);

      process.env.NODE_ENV = 'production';
      process.env.LEAVEPILOT_LICENSE = JSON.stringify({
        payload,
        algorithm: 'RSA-SHA256',
        signature,
      });

      const status = features.getLicenseStatus();
      expect(status.valid).to.equal(false);
      expect(status.reason).to.equal('invalid_signature');
    });
  });
});
