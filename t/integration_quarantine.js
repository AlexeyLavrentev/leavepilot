'use strict';

/*
 * Integration specs excluded from the default browser run.
 *
 * The list is empty, and the goal is to keep it that way: it exists so a
 * genuinely stuck spec can be parked with a written reason instead of the whole
 * job going red and being ignored, which is how the suite rotted before it was
 * wired into CI at all.
 *
 * Each entry states the file, the failing test names and what the assertion
 * actually reported. `node bin/test.js --include-quarantined` runs them anyway.
 */

const fs = require('fs');
const path = require('path');

const validate = entries => {
  (entries || []).forEach(entry => {
    if (!entry || typeof entry.file !== 'string' || !fs.existsSync(path.join(__dirname, 'integration', entry.file))) {
      throw new Error('quarantine entry needs an existing spec file');
    }
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(entry.issue || '')) {
      throw new Error('quarantine entry needs a human-created issue URL');
    }
    if (!entry.owner || !entry.reason) {
      throw new Error('quarantine entry needs owner and reason');
    }
    if (!entry.expiresAt || Number.isNaN(Date.parse(entry.expiresAt)) || Date.parse(entry.expiresAt) <= Date.now()) {
      throw new Error('quarantine entry is expired');
    }
  });
  return entries || [];
};

const quarantine = [];
Object.defineProperties(quarantine, {
  validate: {value: validate},
  evaluate: {value: entries => ({active: (entries || []).length > 0, count: (entries || []).length})},
});

module.exports = quarantine;
