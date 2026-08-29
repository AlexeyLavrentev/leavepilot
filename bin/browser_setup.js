#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  uninstall,
} = require('@puppeteer/browsers');
const { PUPPETEER_REVISIONS } = require('puppeteer-core');

const CACHE_ROOT = path.join(process.cwd(), '.artifacts', 'verify', 'browser');
const BUILD_ID = PUPPETEER_REVISIONS.chrome;

const missingPrerequisiteMessage = () =>
  'browser setup missing; run: node bin/browser_setup.js --bootstrap';

const isWithinCache = (cacheRoot, candidate) => {
  const root = path.resolve(cacheRoot);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
};

const majorVersion = value => {
  const match = String(value || '').match(/(\d+)\./);
  return match ? Number(match[1]) : null;
};

const haveMatchingMajorVersions = (chromeVersion, chromedriverVersion) => {
  const chromeMajor = majorVersion(chromeVersion);
  const driverMajor = majorVersion(chromedriverVersion);
  return chromeMajor !== null && chromeMajor === driverMajor;
};

const readVersion = executable => {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${missingPrerequisiteMessage()} (could not read ${path.basename(executable)} version)`);
  }
  const version = (result.stdout || result.stderr || '').match(/(\d+\.\d+(?:\.\d+){1,2})/);
  if (!version) {
    throw new Error(`${missingPrerequisiteMessage()} (could not parse ${path.basename(executable)} version)`);
  }
  return version[1];
};

const executablePath = browser => computeExecutablePath({
  browser,
  buildId: BUILD_ID,
  cacheDir: CACHE_ROOT,
  platform: detectBrowserPlatform(),
});

const validate = () => {
  const chromeBin = executablePath(Browser.CHROME);
  const chromedriverBin = executablePath(Browser.CHROMEDRIVER);

  [chromeBin, chromedriverBin].forEach(candidate => {
    if (!isWithinCache(CACHE_ROOT, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(missingPrerequisiteMessage());
    }
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      throw new Error(missingPrerequisiteMessage());
    }
  });

  const chromeVersion = readVersion(chromeBin);
  const chromedriverVersion = readVersion(chromedriverBin);
  if (!haveMatchingMajorVersions(chromeVersion, chromedriverVersion)) {
    throw new Error(`${missingPrerequisiteMessage()} (Chrome and ChromeDriver major versions differ)`);
  }

  return { chromeBin, chromedriverBin, chromeVersion, chromedriverVersion };
};

const toPrintEnv = ({ chromeBin, chromedriverBin, chromeVersion, chromedriverVersion }) => ({
  chromeBin,
  chromedriverBin,
  chromeVersion,
  chromedriverVersion,
});

const bootstrap = async () => {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('browser setup cannot determine this platform');
  }
  try {
    return validate();
  } catch {
    // An interrupted official download leaves a build-shaped directory behind.
    // Remove only this pinned pair before asking Puppeteer to verify and fetch it again.
    await Promise.all([Browser.CHROME, Browser.CHROMEDRIVER].map(browser => uninstall({
      browser,
      buildId: BUILD_ID,
      cacheDir: CACHE_ROOT,
      platform,
    })));
  }
  await install({ browser: Browser.CHROME, buildId: BUILD_ID, cacheDir: CACHE_ROOT, platform });
  await install({ browser: Browser.CHROMEDRIVER, buildId: BUILD_ID, cacheDir: CACHE_ROOT, platform });
  return validate();
};

if (require.main === module) {
  const command = process.argv[2] || '--check';
  const operation = command === '--bootstrap' ? bootstrap() : Promise.resolve().then(validate);
  operation.then(result => {
    if (command === '--print-env') {
      process.stdout.write(JSON.stringify(toPrintEnv(result)) + '\n');
    } else if (command !== '--check' && command !== '--bootstrap') {
      throw new Error('browser setup expects --bootstrap, --check, or --print-env');
    }
  }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BUILD_ID,
  CACHE_ROOT,
  haveMatchingMajorVersions,
  isWithinCache,
  missingPrerequisiteMessage,
  toPrintEnv,
  validate,
};
