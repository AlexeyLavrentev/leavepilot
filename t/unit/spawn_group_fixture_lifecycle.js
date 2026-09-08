'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createRequire} = require('node:module');

function fixture() {
  const filename = path.resolve(__dirname, 'spawn_group.js');
  const localRequire = createRequire(filename);
  const timers = new Set();
  const children = [];
  const alive = new Set();
  const signals = [];
  let cleanup;
  let signalFailure;
  function spawn(_command, _args, options) {
    const child = Object.assign(new EventEmitter(), {pid: 40000 + children.length, stdout: new EventEmitter(), options});
    children.push(child);
    alive.add(child.pid);
    return child;
  }
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = {startWithGrandchild};', {
    module, __dirname,
    require: name => name === 'child_process' ? {spawn} : name === '../../bin/lib/spawn_group' ? {
      GROUPS_SUPPORTED: true, spawnInGroup: spawn,
      killGroup: child => {
        signals.push(child.pid);
        if (signalFailure && signals.length === 1) { throw signalFailure; }
        alive.delete(child.pid);
        return true;
      }, terminateGroup() {},
    } : localRequire(name),
    process: {execPath: process.execPath, kill: pid => {
      if (!alive.has(Math.abs(pid))) { throw Object.assign(new Error('gone'), {code: 'ESRCH'}); }
    }},
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    describe: (_title, fn) => fn.call({timeout() {}}), it() {},
    after: fn => { cleanup = fn; }, afterEach: fn => { cleanup = fn; },
  }, {filename});
  return {start: () => module.exports.startWithGrandchild(spawn), children, timers, alive, signals,
    cleanup: () => cleanup(), failSignal: error => { signalFailure = error; }};
}

describe('spawn-group test fixture ownership', function() {
  for (const failure of ['error', 'exit', 'timeout', 'invalid-pid']) {
    it(`owns the parent and clears the deadline after ${failure} before PID acquisition`, async function() {
      const value = fixture();
      const started = value.start();
      const child = value.children[0];
      const rejected = assert.rejects(started);
      if (failure === 'error') { child.emit('error', new Error('spawn failed')); }
      if (failure === 'exit') { child.emit('exit', 1); }
      if (failure === 'timeout') { [...value.timers][0](); }
      if (failure === 'invalid-pid') { child.stdout.emit('data', Buffer.from('not-a-pid\n')); }
      await rejected;
      assert.equal(value.timers.size, 0);
      await value.cleanup();
      assert.deepEqual(value.signals, [child.pid]);
      assert.equal(value.alive.size, 0);
      assert.equal(child.options.detached, true, 'even the plain-kill demonstration needs an owned fixture group');
    });
  }

  it('accepts a split valid PID and reaps the fixture immediately after the test', async function() {
    const value = fixture();
    const started = value.start();
    const child = value.children[0];
    child.stdout.emit('data', Buffer.from('123'));
    child.stdout.emit('data', Buffer.from('45\n'));
    const result = await started;
    assert.equal(result.grandchild, 12345);
    assert.equal(value.timers.size, 0);
    await value.cleanup();
    assert.equal(value.alive.size, 0);
    assert.deepEqual(value.signals, [child.pid]);
  });

  it('still signals later owned groups when the first signal fails', async function() {
    const value = fixture();
    for (let index = 0; index < 2; index += 1) {
      const started = value.start();
      value.children[index].stdout.emit('data', Buffer.from('12345\n'));
      await started;
    }
    const error = new Error('signal failed');
    value.failSignal(error);
    // The failed signal is itself a failure; its simulated PID is gone before
    // the final snapshot so this test does not need a real wait or process.
    value.alive.delete(value.children[0].pid);
    await assert.rejects(value.cleanup(), result => result === error);
    assert.deepEqual(value.signals, value.children.map(child => child.pid));
    assert.equal(value.alive.size, 0);
  });
});
