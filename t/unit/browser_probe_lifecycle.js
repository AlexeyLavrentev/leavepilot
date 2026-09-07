'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {expect} = require('chai');
const {Browser, computeExecutablePath, detectBrowserPlatform} = require('@puppeteer/browsers');
const {spawnInGroup, terminateTree} = require('../../bin/lib/spawn_group');
const {BUILD_ID} = require('../../bin/browser_setup');

const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code !== 'ESRCH') { throw error; } return false; }
};

describe('browser prerequisite process lifecycle', function() {
  this.timeout(20000);
  let directory;
  let child;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-probe-'));
    fs.mkdirSync(path.join(directory, 'bin'));
    fs.symlinkSync(path.join(root, 'bin/browser_setup.js'), path.join(directory, 'bin/browser_setup.js'));
    for (const browser of [Browser.CHROME, Browser.CHROMEDRIVER]) {
      const executable = computeExecutablePath({browser, buildId: BUILD_ID,
        platform: detectBrowserPlatform(), cacheDir: path.join(directory, '.artifacts/verify/browser')});
      fs.mkdirSync(path.dirname(executable), {recursive: true});
      const script = browser === Browser.CHROME
        ? "const {spawn} = require('child_process'); process.on('SIGTERM', () => {}); const leaf = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000000)\"], {detached: true, stdio: 'ignore'}); require('fs').writeFileSync('owned.json', JSON.stringify([process.pid, leaf.pid])); setInterval(() => {}, 1000000);"
        : `console.log('ChromeDriver ${BUILD_ID}');`;
      fs.writeFileSync(executable, `#!${process.execPath}\n${script}\n`, {mode: 0o700});
    }
  });

  afterEach(async () => {
    if (child) { await terminateTree(child, {graceMs: 0}); }
    const owned = path.join(directory, 'owned.json');
    if (fs.existsSync(owned)) {
      // Exact synthetic children recorded by this fixture, never a name sweep.
      for (const pid of JSON.parse(fs.readFileSync(owned))) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') { throw error; } }
      }
    }
    child = null;
    fs.rmSync(directory, {recursive: true, force: true});
  });

  async function exercise(directRunner, signal) {
    child = spawnInGroup(process.execPath, directRunner
      ? [path.join(root, 'bin/test.js'), '--browser', 't/fixtures/not-run.js']
      : [path.join(root, 'bin/browser_setup.js'), '--check'], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, NODE_ENV: 'test'},
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once('exit', (code, exitSignal) => resolve({code, signal: exitSignal}));
      child.once('error', reject);
    });
    const owned = path.join(directory, 'owned.json');
    const readyDeadline = Date.now() + 5000;
    while (!fs.existsSync(owned) && Date.now() < readyDeadline) { await pause(20); }
    expect(fs.existsSync(owned), output).to.equal(true);
    const pids = JSON.parse(fs.readFileSync(owned));
    if (signal) { child.kill(signal); }
    let timer;
    try {
      const result = await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('browser prerequisite never settled')), 12000);
      })]);
      expect(result.code, output).not.to.equal(0);
      if (signal) { expect(result.code, output).to.equal(signal === 'SIGINT' ? 130 : 143); }
      expect(result.signal, output).to.equal(null);
      if (!signal) { expect(output).to.include('browser setup'); }
      const goneDeadline = Date.now() + 2000;
      while (pids.some(alive) && Date.now() < goneDeadline) { await pause(20); }
      expect(pids.filter(alive), 'owned browser probe processes survived').to.deep.equal([]);
      expect(alive(process.pid), 'unrelated test process must remain alive').to.equal(true);
      if (directRunner) {
        const reports = path.join(directory, '.artifacts/verify/process-reports');
        const report = JSON.parse(fs.readFileSync(path.join(reports, fs.readdirSync(reports)[0])));
        expect(report.processes.map(entry => entry.label)).to.deep.equal(['browser_setup.js']);
        expect(report.processes[0].termination).not.to.equal(null);
        expect(report.processes.some(entry => entry.label === 'server')).to.equal(false);
      }
    } finally { clearTimeout(timer); }
  }

  it('bounds a hanging version probe and removes its detached descendant', () => exercise(false));
  it('cleans a standalone probe interrupted by SIGTERM', () => exercise(false, 'SIGTERM'));
  it('cleans a standalone probe interrupted by SIGINT', () => exercise(false, 'SIGINT'));
  it('bounds the direct test runner preflight without starting database/server work', () => exercise(true));
  it('cleans a direct runner preflight interrupted by SIGTERM', () => exercise(true, 'SIGTERM'));
  it('cleans a direct runner preflight interrupted by SIGINT', () => exercise(true, 'SIGINT'));
});
