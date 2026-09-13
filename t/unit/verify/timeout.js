'use strict';

const {expect} = require('chai');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {EventEmitter, once} = require('events');
const {
  GROUPS_SUPPORTED,
  spawnInGroup,
  terminateGroup,
  killGroup,
} = require('../../../bin/lib/spawn_group');

const node = process.execPath;

const simulateTermination = async code => {
  const delays = [];
  const signals = [];
  const context = {
    module: {exports: {}}, require,
    process: {platform: 'darwin', kill(pid, signal) {
      signals.push({pid, signal});
      if (code) { throw Object.assign(new Error(code), {code}); }
    }},
    setTimeout(callback, delay) { delays.push(delay); queueMicrotask(callback); return 1; },
    clearTimeout() {},
    setInterval() { return 2; },
    clearInterval() {},
  };
  vm.runInNewContext(fs.readFileSync(path.resolve('bin/lib/spawn_group.js'), 'utf8'), context);
  const child = Object.assign(new EventEmitter(), {pid: 123});
  const outcome = await context.module.exports.terminateGroup(child);
  return {delays, signals, outcome};
};

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};

const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
};

const startTermResistantTree = (parentExits = false) => new Promise((resolve, reject) => {
  const child = spawnInGroup(node, ['-e', `
    const {spawn} = require('child_process');
    const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000000)"], {stdio: ['ignore', 'pipe', 'ignore']});
    process.on('SIGTERM', () => { ${parentExits ? 'process.exit(0);' : ''} });
    grandchild.stdout.once('data', () => process.stdout.write(String(grandchild.pid) + '\\n'));
    setInterval(() => {}, 1000000);
  `], {stdio: ['ignore', 'pipe', 'ignore']});
  let output = '';
  const timeout = setTimeout(() => reject(new Error('fixture did not report grandchild pid')), 5000);

  child.stdout.on('data', chunk => {
    output += chunk.toString();
    if (output.includes('\n')) {
      clearTimeout(timeout);
      resolve({child, grandchildPid: Number(output.trim())});
    }
  });
  child.once('error', reject);
});

describe('verification timeout contract', function() {
  this.timeout(10000);

  it('does not schedule a grace wait after the group is already absent', async function() {
    const result = await simulateTermination('ESRCH');
    expect(result.delays).to.deep.equal([]);
    expect(result.signals).to.deep.equal([{pid: -123, signal: 'SIGTERM'}]);
    expect(result.outcome.termSent).to.equal(false);
    expect(result.outcome.errors).to.have.lengthOf(0);
  });

  it('still waits and escalates for a live group or a permission failure', async function() {
    for (const code of [null, 'EPERM']) {
      const result = await simulateTermination(code);
      expect(result.delays).to.deep.equal([5000]);
      expect(result.signals.map(entry => entry.signal)).to.deep.equal(['SIGTERM', 'SIGKILL']);
      expect(result.outcome.errors).to.have.lengthOf(code ? 2 : 0);
    }
  });

  it('records TERM to KILL escalation and leaves no TERM-resistant descendant', async function() {
    if (!GROUPS_SUPPORTED) {
      return this.skip();
    }

    const {child, grandchildPid} = await startTermResistantTree();
    const outcome = await terminateGroup(child, {graceMs: 50});

    expect(outcome).to.deep.include({
      termSent: true,
      graceExited: false,
      killSent: true,
      finalSweepSent: false,
    });
    expect(await waitFor(() => !isAlive(child.pid) && !isAlive(grandchildPid), 3000)).to.equal(true);
  });

  it('records a final sweep after a child exits during the grace period', async function() {
    if (!GROUPS_SUPPORTED) {
      return this.skip();
    }

    const child = spawnInGroup(node, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000000)"]);
    const outcome = await terminateGroup(child, {graceMs: 500});

    expect(outcome).to.deep.include({
      termSent: true,
      graceExited: true,
      killSent: false,
      finalSweepSent: false,
    });
  });

  it('observes an exited group when only a PID handle is available', async function() {
    if (!GROUPS_SUPPORTED) { return this.skip(); }
    const child = spawnInGroup(node, ['-e', 'setInterval(() => {}, 1000000)'], {stdio: 'ignore'});
    const exited = once(child, 'exit');
    try {
      await once(child, 'spawn');
      const handle = Object.assign(new EventEmitter(), {pid: child.pid});
      const start = performance.now();
      await terminateGroup(handle);
      await exited;
      expect(performance.now() - start).to.be.lessThan(1000);
      expect(isAlive(-child.pid)).to.equal(false);
    } finally {
      killGroup(child, 'SIGKILL');
      await exited;
    }
  });

  it('does not mistake leader exit for group exit with a PID-only handle', async function() {
    if (!GROUPS_SUPPORTED) { return this.skip(); }
    const {child, grandchildPid} = await startTermResistantTree(true);
    const survivorAtLeaderExit = once(child, 'exit').then(() => isAlive(grandchildPid));
    try {
      const handle = Object.assign(new EventEmitter(), {pid: child.pid});
      const outcome = await terminateGroup(handle, {graceMs: 300});
      expect(await survivorAtLeaderExit).to.equal(true);
      expect(outcome).to.include({graceExited: false, killSent: true});
      expect(await waitFor(() => !isAlive(grandchildPid), 3000)).to.equal(true);
    } finally {
      killGroup(child, 'SIGKILL');
      await survivorAtLeaderExit;
    }
  });
});
