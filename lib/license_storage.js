'use strict';

const fs = require('fs');
const path = require('path');
const envResolver = require('./env_resolver');
const config = require('./config');

const DEFAULT_LICENSE_FILE = 'data/license.json';

const getLicenseFilePath = () =>
  envResolver.resolve('LICENSE_FILE')
  || config.get('license_file')
  || DEFAULT_LICENSE_FILE;

// Read license from file. Returns { raw, source } or { raw: null, source: 'none' }.
const readLicenseFile = () => {
  const filePath = getLicenseFilePath();
  const resolvedPath = path.resolve(filePath);

  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');

    if (!content || !content.trim()) {
      return { raw: null, source: 'none' };
    }

    return { raw: content.trim(), source: 'file' };
  } catch {
    return { raw: null, source: 'none' };
  }
};

// Write license to file. Returns true on success, false on error.
const writeLicenseFile = licenseJson => {
  const filePath = getLicenseFilePath();
  const resolvedPath = path.resolve(filePath);

  try {
    const dir = path.dirname(resolvedPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = typeof licenseJson === 'string'
      ? licenseJson
      : JSON.stringify(licenseJson, null, 2);

    fs.writeFileSync(resolvedPath, content, 'utf8');
    return true;
  } catch {
    return false;
  }
};

module.exports = {
  getLicenseFilePath,
  readLicenseFile,
  writeLicenseFile,
};
