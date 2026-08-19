'use strict';

const { expect } = require('chai');
const path = require('path');
const { computeModuleHash, verifyModuleHash } = require('../../lib/module_integrity');

describe('module_integrity', () => {
  const testModulePath = path.resolve(__dirname, '../../lib');

  describe('computeModuleHash', () => {
    it('returns non-null string for existing module', () => {
      const hash = computeModuleHash(testModulePath);
      expect(hash).to.be.a('string');
      expect(hash).to.not.be.null;
    });

    it('returns 64-char hex string (SHA-256)', () => {
      const hash = computeModuleHash(testModulePath);
      expect(hash).to.match(/^[0-9a-f]{64}$/);
    });

    it('is deterministic', () => {
      const first = computeModuleHash(testModulePath);
      const second = computeModuleHash(testModulePath);
      expect(first).to.equal(second);
    });

    it('returns null for non-existent path', () => {
      const hash = computeModuleHash('/nonexistent/path');
      expect(hash).to.be.null;
    });
  });

  describe('verifyModuleHash', () => {
    it('returns null when expectedHash is absent', () => {
      const result = verifyModuleHash(testModulePath, null);
      expect(result).to.be.null;
    });

    it('returns null when hash matches', () => {
      const hash = computeModuleHash(testModulePath);
      const result = verifyModuleHash(testModulePath, hash);
      expect(result).to.be.null;
    });

    it('returns error when hash does not match', () => {
      const result = verifyModuleHash(testModulePath, '0'.repeat(64));
      expect(result).to.equal('integrity_mismatch');
    });

    it('returns error when module path is invalid', () => {
      const result = verifyModuleHash('/nonexistent/path', '0'.repeat(64));
      expect(result).to.equal('integrity_check_failed');
    });
  });
});
