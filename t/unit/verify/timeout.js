'use strict';

const {expect} = require('chai');
const {
  GROUPS_SUPPORTED,
  spawnInGroup,
  terminateGroup,
} = require('../../../bin/lib/spawn_group');

const node = process.execPath;

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

const startTermResistantTree = () => new Promise((resolve, reject) => {
  const child = spawnInGroup(node, ['-e', `
    const {spawn} = require('child_process');
    const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000000)"], {stdio: 'ignore'});
    process.on('SIGTERM', () => {});
    process.stdout.write(String(grandchild.pid) + '\\n');
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
});
