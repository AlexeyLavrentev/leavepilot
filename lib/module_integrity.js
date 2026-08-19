'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Compute SHA-256 hash of all .js files in a directory (sorted for determinism).
// Skips node_modules and .git. Returns 64-char hex string or null on error.
const computeModuleHash = modulePath => {
  try {
    const resolvedPath = path.resolve(modulePath);
    const files = [];

    const walkDir = dir => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          files.push(fullPath);
        }
      }
    };

    walkDir(resolvedPath);

    if (files.length === 0) {
      return null;
    }

    const hash = crypto.createHash('sha256');

    for (const file of files.sort()) {
      hash.update(fs.readFileSync(file));
    }

    return hash.digest('hex');
  } catch (_e) {
    return null;
  }
};

// Verify module hash matches expected. Returns null on success, error string
// on failure. Returns null when expectedHash is absent (no check needed).
const verifyModuleHash = (modulePath, expectedHash) => {
  if (!expectedHash) {
    return null;
  }

  const actualHash = computeModuleHash(modulePath);

  if (!actualHash) {
    return 'integrity_check_failed';
  }

  return actualHash === expectedHash ? null : 'integrity_mismatch';
};

module.exports = {
  computeModuleHash,
  verifyModuleHash,
};
