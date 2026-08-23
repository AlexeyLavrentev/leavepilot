'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readLicenseFile, writeLicenseFile, getLicenseFilePath } = require('../../lib/license_storage');

describe('license_storage', () => {
  const tmpDir = path.join(os.tmpdir(), 'leavepilot-test-' + Date.now());
  const tmpFile = path.join(tmpDir, 'test-license.json');

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) { /* ignore */ }
  });

  describe('readLicenseFile', () => {
    it('returns { raw: null, source: "none" } when no file exists', () => {
      const config = require('../../lib/config');
      const originalPath = getLicenseFilePath();
      config.set('license_file', path.join(tmpDir, 'nonexistent-license.json'));

      const result = readLicenseFile();
      expect(result.raw).to.be.null;
      expect(result.source).to.equal('none');

      config.set('license_file', undefined);
    });
  });

  describe('writeLicenseFile', () => {
    it('creates file and readLicenseFile reads it back', () => {
      const license = JSON.stringify({ payload: { test: true }, algorithm: 'RSA-SHA256', signature: 'sig' });
      const originalPath = getLicenseFilePath();

      // Override config for test
      const config = require('../../lib/config');
      config.set('license_file', tmpFile);

      const written = writeLicenseFile(license);
      expect(written).to.equal(true);

      const result = readLicenseFile();
      expect(result.raw).to.equal(license);
      expect(result.source).to.equal('file');

      // Restore
      config.set('license_file', undefined);
    });

    it('creates parent directories', () => {
      const deepFile = path.join(tmpDir, 'deep', 'nested', 'license.json');
      const config = require('../../lib/config');
      config.set('license_file', deepFile);

      const written = writeLicenseFile('{"test":true}');
      expect(written).to.equal(true);
      expect(fs.existsSync(deepFile)).to.equal(true);

      config.set('license_file', undefined);
    });
  });

  describe('getLicenseFilePath', () => {
    it('returns default path when not configured', () => {
      const config = require('../../lib/config');
      config.set('license_file', undefined);
      delete process.env.LEAVEPILOT_LICENSE_FILE;

      const filePath = getLicenseFilePath();
      expect(filePath).to.equal('data/license.json');
    });
  });
});
