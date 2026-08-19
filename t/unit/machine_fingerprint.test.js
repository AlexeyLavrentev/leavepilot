'use strict';

const { expect } = require('chai');
const { collectComponents, generateFingerprint } = require('../../lib/machine_fingerprint');

describe('machine_fingerprint', () => {
  describe('collectComponents', () => {
    it('returns non-empty array', () => {
      const components = collectComponents();
      expect(components).to.be.an('array');
      expect(components.length).to.be.greaterThan(0);
    });

    it('each component has key:value format', () => {
      const components = collectComponents();
      for (const component of components) {
        expect(component).to.match(/^[a-z]+:.+$/);
      }
    });

    it('includes hostname', () => {
      const components = collectComponents();
      const hostname = components.find(c => c.startsWith('hostname:'));
      expect(hostname).to.be.a('string');
    });

    it('includes platform', () => {
      const components = collectComponents();
      const platform = components.find(c => c.startsWith('platform:'));
      expect(platform).to.be.a('string');
    });
  });

  describe('generateFingerprint', () => {
    it('returns non-null string', () => {
      const fingerprint = generateFingerprint();
      expect(fingerprint).to.be.a('string');
      expect(fingerprint).to.not.be.null;
    });

    it('returns 64-char hex string (SHA-256)', () => {
      const fingerprint = generateFingerprint();
      expect(fingerprint).to.match(/^[0-9a-f]{64}$/);
    });

    it('is deterministic', () => {
      const first = generateFingerprint();
      const second = generateFingerprint();
      expect(first).to.equal(second);
    });
  });
});
