'use strict';

const crypto = require('crypto');
const os = require('os');

// Collect hardware components for fingerprinting. Sorted for determinism.
// Returns array of 'key:value' strings. Graceful: never throws.
const collectComponents = () => {
  const components = [];

  try {
    components.push('hostname:' + os.hostname());
  } catch { /* skip */ }

  try {
    const interfaces = os.networkInterfaces();
    const macs = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macs.push(iface.mac);
        }
      }
    }

    macs.sort();
    for (const mac of macs) {
      components.push('mac:' + mac);
    }
  } catch { /* skip */ }

  try {
    const cpus = os.cpus();
    if (cpus.length > 0) {
      components.push('cpu:' + cpus[0].model);
    }
  } catch { /* skip */ }

  try {
    components.push('platform:' + os.platform());
    components.push('arch:' + os.arch());
  } catch { /* skip */ }

  return components;
};

// Generate deterministic machine fingerprint. Returns 64-char hex string
// (SHA-256) or null on error.
const generateFingerprint = () => {
  try {
    const components = collectComponents();

    if (components.length === 0) {
      return null;
    }

    const hash = crypto.createHash('sha256');
    hash.update(components.join('|'));
    return hash.digest('hex');
  } catch {
    return null;
  }
};

module.exports = {
  collectComponents,
  generateFingerprint,
};
