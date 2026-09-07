#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {spawnInGroup, terminateGroup, terminateTree, DEFAULT_GRACE_MS} = require('./lib/spawn_group');
const {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  uninstall,
} = require('@puppeteer/browsers');

const CACHE_ROOT = path.join(process.cwd(), '.artifacts', 'verify', 'browser');
// Keep Chrome-for-Testing and ChromeDriver on one repository-owned build.
// Do not derive this from Puppeteer's revision: its release cadence is separate
// from this suite's verified browser contract.
const BUILD_ID = '152.0.7977.64';
// Version queries normally finish in milliseconds. Reuse the existing process
// grace budget as their ceiling; unlike installation, they do not need network.
const VERSION_PROBE_TIMEOUT_MS = DEFAULT_GRACE_MS;
const activeProbes = new Set();
let interruptedSignal = null;

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

const readVersion = executable => new Promise((resolve, reject) => {
  if (interruptedSignal) { reject(new Error(`browser setup interrupted by ${interruptedSignal}`)); return; }
  const child = spawnInGroup(executable, ['--version'], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  let failure = null;
  let termination = null;
  const cancel = reason => {
    failure = failure || reason;
    // A read-only version probe has no state to flush. Immediate escalation
    // finishes before its owning runner's normal shutdown grace expires.
    termination = termination || terminateTree(child, {graceMs: 0});
  };
  const timer = setTimeout(() => cancel('version probe timed out'), VERSION_PROBE_TIMEOUT_MS);
  activeProbes.add(cancel);
  const finish = () => { clearTimeout(timer); activeProbes.delete(cancel); };
  const error = reason => new Error(`${missingPrerequisiteMessage()} (${path.basename(executable)}: ${reason})`);
  const collectOutput = chunk => {
    if (failure) { return; }
    if (Buffer.byteLength(output) + chunk.length > 4096) { cancel('version output exceeded limit'); return; }
    output += chunk;
  };
  child.stdout.on('data', collectOutput);
  child.stderr.on('data', collectOutput);
  child.once('error', () => { finish(); reject(error('could not start version probe')); });
  child.once('exit', async code => {
    clearTimeout(timer);
    try {
      if (termination) {
        const outcome = await termination;
        if (outcome.snapshotError) { failure += `; process ancestry unavailable: ${outcome.snapshotError}`; }
        if (outcome.groups.some(group => group.errors.length)) { failure += '; process group cleanup reported signal errors'; }
      } else {
        const outcome = await terminateGroup(child, {graceMs: 0});
        if (outcome.termSent || outcome.errors.length) { failure = 'version probe left a surviving process group'; }
      }
      const version = output.match(/(\d+\.\d+(?:\.\d+){1,2})/);
      if (failure || code !== 0 || !version) { reject(error(failure || 'could not read version')); }
      else { resolve(version[1]); }
    } catch { reject(error('could not clean up version probe')); }
    finally { finish(); }
  });
});

const executablePath = browser => computeExecutablePath({
  browser,
  buildId: BUILD_ID,
  cacheDir: CACHE_ROOT,
  platform: detectBrowserPlatform(),
});

const isPinnedArchiveName = name => name.startsWith(`${BUILD_ID}-`);

const removePinnedArchives = browser => {
  const browserRoot = path.join(CACHE_ROOT, browser);
  if (!isWithinCache(CACHE_ROOT, browserRoot) || !fs.existsSync(browserRoot)) {
    return;
  }
  fs.readdirSync(browserRoot, { withFileTypes: true }).forEach(entry => {
    if (entry.isFile() && isPinnedArchiveName(entry.name)) {
      fs.rmSync(path.join(browserRoot, entry.name));
    }
  });
};

const bootstrapBrowser = async ({ browser, platform }) => {
  const options = {
    browser,
    buildId: BUILD_ID,
    cacheDir: CACHE_ROOT,
    platform,
  };
  try {
    return await install(options);
  } catch {
    // Recover only the broken pinned artifact. A valid Chrome cache must not
    // be discarded merely because its matching driver is absent.
    await uninstall(options);
    removePinnedArchives(browser);
    return install(options);
  }
};

const validate = async () => {
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

  const chromeVersion = await readVersion(chromeBin);
  const chromedriverVersion = await readVersion(chromedriverBin);
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
  await bootstrapBrowser({ browser: Browser.CHROME, platform });
  await bootstrapBrowser({ browser: Browser.CHROMEDRIVER, platform });
  return validate();
};

if (require.main === module) {
  ['SIGINT', 'SIGTERM'].forEach(signal => process.on(signal, () => {
    interruptedSignal = interruptedSignal || signal;
    // Outside version probing (for example while downloading), preserve the
    // CLI's former immediate signal exit instead of keeping installation alive.
    if (activeProbes.size === 0) { process.exit(interruptedSignal === 'SIGINT' ? 130 : 143); }
    for (const cancel of activeProbes) { cancel(`interrupted by ${signal}`); }
    process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143;
  }));
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
    process.exitCode = interruptedSignal === 'SIGINT' ? 130 : interruptedSignal ? 143 : 1;
  });
}

module.exports = {
  BUILD_ID,
  CACHE_ROOT,
  bootstrapBrowser,
  haveMatchingMajorVersions,
  isWithinCache,
  isPinnedArchiveName,
  missingPrerequisiteMessage,
  toPrintEnv,
  validate,
};
