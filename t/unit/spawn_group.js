'use strict';

/*
  A test batch is three processes: mocha, the chromedriver it starts, and the
  browser chromedriver starts. The runner kills a batch that has stopped making
  progress, and it killed exactly one of the three - with SIGKILL, which cannot
  be caught, so nothing had the chance to close the browser. The other two were
  reparented to init and stayed there.

  Measured on a development machine after a few days of that: 1494 surviving
  Chrome processes holding 22.6 GB on a machine with 16 GB, 165 of the 166
  browser sessions with no parent left, the oldest two and a half days old.
  0.1 GB of memory free, 17 of 18 GB of swap in use, and a new run could not
  start a browser at all.

  These are behavioural rather than a read of the runner's source: whether a
  signal reaches a grandchild is not a property of how the call is written, and
  the first version of this fix could have been asserted "correct" by reading it
  while leaving every browser running.
*/

const expect = require('chai').expect;
const { spawn } = require('child_process');
const { spawnInGroup, killGroup, terminateGroup, GROUPS_SUPPORTED } = require('../../bin/lib/spawn_group');

const node = process.execPath;

// EPERM means it is alive and belongs to someone else, which for this purpose
// is alive. Only ESRCH means gone.
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

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return predicate();
};

/*
  Stands in for mocha: it starts a long-lived child of its own - the browser -
  reports that child's pid, and then hangs, which is the state the runner kills.
  `traps` makes it ignore SIGTERM, the way a process wedged on a socket does.
*/
const parentScript = traps => `
  const {spawn} = require('child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], {stdio: 'ignore'});
  ${traps ? "process.on('SIGTERM', () => {});" : ''}
  process.stdout.write(String(child.pid) + '\\n');
  setInterval(() => {}, 1000000);
`;

const startWithGrandchild = (spawner, traps = false) => new Promise((resolve, reject) => {
  const child = spawner(node, ['-e', parentScript(traps)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  let buffered = '';

  const timer = setTimeout(() => reject(new Error('no grandchild pid was reported')), 10000);

  child.stdout.on('data', chunk => {
    buffered += chunk.toString();

    if (buffered.includes('\n')) {
      clearTimeout(timer);
      resolve({child, grandchild: Number(buffered.trim())});
    }
  });

  child.on('error', reject);
});

describe('Killing a test batch', function() {

  this.timeout(30000);

  const strays = [];

  after(function() {
    // Nothing this file starts is allowed to outlive it, least of all a file
    // about processes outliving things.
    strays.forEach(pid => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    });
  });

  /*
    The state before this change, kept as a test because it is the reason for
    it: killing the process the runner holds a handle to leaves everything that
    process started running. Not a claim about the runner as it stands now - it
    spawns through spawnInGroup - but about what a plain spawn and kill do.
  */
  it('used to leave the browser behind: a plain kill reaches one process', async function() {
    if (!GROUPS_SUPPORTED) {
      return this.skip();
    }

    const {child, grandchild} = await startWithGrandchild(spawn);

    strays.push(grandchild);
    child.kill('SIGKILL');

    await waitFor(() => !isAlive(child.pid), 5000);

    expect(isAlive(child.pid)).to.equal(false, 'the process that was killed is still running');
    expect(isAlive(grandchild)).to.equal(
      true,
      'this test no longer demonstrates anything: the grandchild died on its own'
    );
  });

  it('takes what the batch started with it', async function() {
    if (!GROUPS_SUPPORTED) {
      return this.skip();
    }

    const {child, grandchild} = await startWithGrandchild(spawnInGroup);

    strays.push(grandchild);

    await terminateGroup(child, {graceMs: 1000});

    expect(await waitFor(() => !isAlive(grandchild), 5000)).to.equal(
      true,
      'the browser is still running after its batch was killed'
    );
    expect(isAlive(child.pid)).to.equal(false);
  });

  /*
    The case the runner is actually in: it kills a batch precisely because that
    batch has stopped responding, so a polite signal on its own is not enough.
  */
  it('escalates when the batch ignores the polite signal', async function() {
    if (!GROUPS_SUPPORTED) {
      return this.skip();
    }

    const {child, grandchild} = await startWithGrandchild(spawnInGroup, true);

    strays.push(grandchild);

    const startedAt = Date.now();

    await terminateGroup(child, {graceMs: 300});

    expect(await waitFor(() => !isAlive(child.pid) && !isAlive(grandchild), 5000)).to.equal(
      true,
      'a batch that ignores SIGTERM survived being terminated'
    );
    expect(Date.now() - startedAt).to.be.above(
      250,
      'it escalated without giving the batch its grace period'
    );
  });

  it('sweeps a group that outlived an ordinary exit', async function() {
    if (!GROUPS_SUPPORTED) {
      return this.skip();
    }

    // What a driver.quit() that timed out leaves behind: the batch finishes and
    // returns 0, and its browser is still there.
    const {child, grandchild} = await startWithGrandchild(spawnInGroup);

    strays.push(grandchild);
    child.kill('SIGKILL');
    await waitFor(() => !isAlive(child.pid), 5000);

    expect(isAlive(grandchild)).to.equal(true, 'nothing left to sweep');

    killGroup(child, 'SIGKILL');

    expect(await waitFor(() => !isAlive(grandchild), 5000)).to.equal(
      true,
      'the sweep after exit did not reach it'
    );
  });

  it('says nothing was there rather than throwing at an empty group', function() {
    if (!GROUPS_SUPPORTED) {
      return this.skip();
    }

    // The ordinary case: a batch that exited cleanly and closed its browser.
    // A sweep then finds nothing, which is not a failure.
    expect(killGroup({pid: 0x7ffffffe}, 'SIGKILL')).to.equal(false);
    expect(killGroup(null, 'SIGKILL')).to.equal(false);
  });

  describe('how the runner uses it', function() {

    const fs = require('fs');
    const path = require('path');

    const runner = fs.readFileSync(path.join(__dirname, '..', '..', 'bin', 'test.js'), 'utf8')
      .split('\n')
      .filter(line => !/^\s*\/\//.test(line))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    it('spawns its batches into a group', function() {
      expect(runner).to.match(/const child = spawnInGroup\(/);
    });

    it('terminates the group rather than the batch on a timeout', function() {
      expect(runner).to.match(/terminateGroup\(child\)/);
      expect(runner).to.not.match(
        /child\.kill\('SIGKILL'\)/,
        'the timeout still kills the batch alone'
      );
    });

    it('sweeps after every exit, not only after a kill', function() {
      const onExit = runner.slice(runner.indexOf("child.on('exit'"));

      expect(onExit.slice(0, 500)).to.match(/terminateGroup\(child(?:,|\))/);
    });

    /*
      A detached child is out of the terminal's foreground group, so Ctrl-C
      stops the runner and not the batch. Without this, interrupting a run leaks
      exactly what the rest of this is preventing.
    */
    it('forwards an interrupt to the batches it has going', function() {
      expect(runner).to.match(/\['SIGINT', 'SIGTERM'\]\.forEach/);
      expect(runner).to.match(/Promise\.all\(Array\.from\(liveChildren\)\.map\(child => terminateGroup\(child\)\)\)/);
    });
  });
});
