'use strict';

const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const path = require('node:path');
const {spawnInGroup, terminateTree} = require('../../bin/lib/spawn_group');
const runtimeShutdown = require('../../lib/runtime_shutdown');

const root = path.join(__dirname, '../..');
const fixture = path.join(root, 't/fixtures/runtime/shutdown_case.js');

function liveMembers(pid) {
  if (process.platform === 'win32') { return []; }
  const output = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], {encoding: 'utf8', timeout: 1000});
  return output.split('\n').map(line => line.trim().split(/\s+/))
    .filter(parts => Number(parts[1]) === pid && parts[2] && !parts[2].startsWith('Z'))
    .map(parts => Number(parts[0]));
}

function runChild(mode) {
  const child = spawnInGroup(process.execPath, [fixture, mode], {
    cwd: root, env: {...process.env, NODE_ENV: 'test'}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const events = [];
  const waiters = [];
  let output = '';
  let closed;
  const closedPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = {code, signal}; resolve(closed); });
  });
  child.on('message', message => {
    events.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.event === message.event) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
  const waitFor = (event, ms = 1500) => {
    const prior = events.find(message => message.event === event);
    if (prior) { return Promise.resolve(prior); }
    return new Promise((resolve, reject) => {
      const waiter = {event, resolve, reject};
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`child did not report ${event}: ${output}`));
      }, ms);
      waiters.push(waiter);
    });
  };
  const finish = async () => {
    const watchdog = setTimeout(() => { void terminateTree(child, {graceMs: 100}); }, 1800);
    try {
      await closedPromise;
      assert.deepEqual(liveMembers(child.pid), [], `owned process survived: ${output}`);
      return {events, output, ...closed};
    } finally { clearTimeout(watchdog); }
  };
  return {child, events, waitFor, finish, cleanup: () => closed ? Promise.resolve() : terminateTree(child, {graceMs: 100})};
}

describe('Runtime shutdown coordinator', function() {
  it('shares cleanup, runs it once and preserves first fatal classification', async function() {
    const closes = [];
    const exits = [];
    const shutdown = runtimeShutdown.createShutdownCoordinator({
      server: {close: callback => { closes.push('http'); callback(); }},
      sessionLifecycle: {close: () => { closes.push('store'); }},
      db: {close: () => { closes.push('sql'); }},
      exit: code => exits.push(code), timeoutMs: 100,
    });
    const first = shutdown('fatal_test', new Error('boom'), 1);
    assert.equal(shutdown('sigterm', null, 0), first);
    await first;
    assert.deepEqual(closes, ['http', 'store', 'sql']);
    assert.deepEqual(exits, [1]);
  });

  it('does not install fatal listeners by importing app.js source', function() {
    const source = require('node:fs').readFileSync(path.join(root, 'app.js'), 'utf8');
    assert.equal(source.includes("process.on('uncaughtException'"), false);
    assert.equal(source.includes("process.on('unhandledRejection'"), false);
  });

  for (const kind of ['uncaughtException', 'unhandledRejection']) {
    it(`logs ${kind} once and exits nonzero`, async function() {
      const script = [
        "const r=require('./lib/runtime_shutdown')",
        "r.installProcessHandlers({timeoutMs:100,exit:code=>process.exit(code)})",
        kind === 'uncaughtException'
          ? "setImmediate(()=>{throw new Error('fatal-fixture')})"
          : "Promise.reject(new Error('fatal-fixture'))",
      ].join(';');
      const child = spawnInGroup(process.execPath, ['-e', script], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const watchdog = setTimeout(() => { void terminateTree(child, {graceMs: 100}); }, 1500);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.equal(code, 1);
        assert.equal(stderr.split('\n').filter(line => line.includes(kind === 'uncaughtException' ? 'uncaught_exception' : 'unhandled_rejection')).length, 1);
      } finally { clearTimeout(watchdog); }
    });
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    it(`drains a real session save before Store and SQL on ${signal}`, async function() {
      const run = runChild('delayed-save');
      try {
        const {port} = await run.waitFor('ready');
        const response = fetch(`http://127.0.0.1:${port}/write`);
        await run.waitFor('save-pending');
        run.child.kill(signal);
        run.child.kill(signal);
        await run.waitFor('listener-closing');
        assert.equal(run.events.some(event => event.event === 'store-close'), false);
        run.child.send({event: 'release-save'});
        assert.equal((await response).status, 200);
        const result = await run.finish();
        assert.equal(result.code, 0, result.output);
        const order = result.events.map(event => event.event);
        assert.ok(order.indexOf('save-complete') < order.indexOf('store-close'), order.join(','));
        assert.ok(order.indexOf('store-close') < order.indexOf('sql-close'), order.join(','));
        assert.equal(order.filter(event => event === 'exit').length, 1);
      } finally { await run.cleanup(); }
    });
  }

  for (const mode of ['stalled-request', 'reject-store', 'hung-sql']) {
    it(`forces a bounded nonzero exit for ${mode}`, async function() {
      const run = runChild(mode);
      try {
        const {port} = await run.waitFor('ready');
        if (mode === 'stalled-request') {
          void fetch(`http://127.0.0.1:${port}/stall`).catch(() => {});
          await run.waitFor('request-entered');
        }
        run.child.kill('SIGTERM');
        const result = await run.finish();
        assert.equal(result.code, 1, result.output);
        assert.equal(result.events.filter(event => event.event === 'exit').length, 1);
      } finally { await run.cleanup(); }
    });
  }

  it('does not terminate an unrelated sentinel', async function() {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    const run = runChild('stalled-request');
    try {
      const {port} = await run.waitFor('ready');
      void fetch(`http://127.0.0.1:${port}/stall`).catch(() => {});
      await run.waitFor('request-entered');
      run.child.kill('SIGINT');
      assert.equal((await run.finish()).code, 1);
      assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    } finally {
      await run.cleanup();
      sentinel.kill('SIGKILL');
    }
  });
});
