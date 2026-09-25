'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnInGroup, terminateGroup} = require('../../bin/lib/spawn_group');
const {startRuntime} = require('../../lib/runtime_startup');

const root = path.join(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const barrier = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return {promise, release};
};

function makeRuntime(overrides = {}) {
  const events = [];
  const gate = barrier();
  let notify;
  let subscribed = 0;
  let unsubscribed = 0;
  const lifecycle = {
    initialize: () => gate.promise,
    close: async () => { events.push('store.close'); },
    onStateChange: listener => {
      subscribed += 1;
      notify = listener;
      return () => { unsubscribed += 1; };
    },
  };
  const db = {
    connect: async () => { events.push('db.connect'); },
    sequelize: {close: async () => { events.push('db.close'); }},
  };
  const app = {
    get: key => key === 'db_model' ? db : key === 'session_middleware' ? {sessionLifecycle: lifecycle} : undefined,
    set: () => {},
  };
  const server = {address: () => ({port: 43210}), close: callback => { events.push('listener.close'); callback(); }};
  const runtime = startRuntime({
    loadApp: () => app,
    listen: async () => { events.push('listen'); return server; },
    startSchedulers: () => { events.push('schedulers'); },
    installHandlers: shutdown => { events.push('handlers'); return shutdown; },
    exit: code => { events.push(`exit:${code}`); },
    sendReady: () => { events.push('ready'); },
    log: () => {},
    ...overrides,
  });
  return {runtime, events, gate, lifecycle, notify: state => notify(state), subscription: () => ({subscribed, unsubscribed})};
}

function childRun(args, env, deadlineMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawnInGroup(process.execPath, args, {
      cwd: root,
      env: {...process.env, ...env},
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages = [];
    let output = '';
    let ended = false;
    child.on('message', message => { messages.push(message); });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      ended = true;
      clearTimeout(watchdog);
      resolve({code, signal, messages, output: output.slice(-2000)});
    });
    const watchdog = setTimeout(async () => {
      if (ended) { return; }
      await terminateGroup(child, {graceMs: 200});
      reject(new Error(`child deadline exceeded: ${args[0]}`));
    }, deadlineMs);
  });
}

describe('direct runtime startup owner', function() {
  it('waits for selected Store readiness and memoizes duplicate starts', async function() {
    const {runtime, events, gate, subscription} = makeRuntime();
    const first = runtime.start();
    const second = runtime.start();
    await wait(20);
    assert.equal(events.includes('listen'), false);
    assert.equal(events.includes('ready'), false);
    gate.release();
    await Promise.all([first, second]);
    assert.equal(events.filter(event => event === 'listen').length, 1);
    assert.equal(events.filter(event => event === 'ready').length, 1);
    assert.deepEqual(subscription(), {subscribed: 1, unsubscribed: 0});
    await runtime.shutdown('sigterm', null, 0);
    assert.deepEqual(events.slice(-4), ['listener.close', 'store.close', 'db.close', 'exit:0']);
  });

  it('rejects late readiness after shutdown during initialization', async function() {
    const {runtime, events, gate, subscription} = makeRuntime();
    const starting = runtime.start();
    await wait(20);
    await runtime.shutdown('sigterm', null, 0);
    gate.release();
    await starting;
    assert.equal(events.includes('listen'), false);
    assert.equal(events.includes('ready'), false);
    assert.deepEqual(subscription(), {subscribed: 1, unsubscribed: 1});
  });

  it('routes a post-ready Store failure through one nonzero terminal close', async function() {
    const {runtime, events, gate, notify, subscription} = makeRuntime();
    gate.release();
    await runtime.start();
    notify({state: 'failed', error: new Error('store unavailable')});
    notify({state: 'failed', error: new Error('duplicate')});
    await runtime.whenStopped();
    notify({state: 'ready'});
    assert.deepEqual(events.slice(-4), ['listener.close', 'store.close', 'db.close', 'exit:1']);
    assert.deepEqual(subscription(), {subscribed: 1, unsubscribed: 1});
    assert.equal(events.filter(event => event === 'ready').length, 1);
  });

  it('serves a migrated SQLite login session then stops idle with no survivor', async function() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-startup-'));
    const storage = path.join(directory, 'app.sqlite');
    const env = {
      NODE_ENV: 'development', DB_DIALECT: 'sqlite', DB_STORAGE: storage,
      DB_LOGGING: 'false', PORT: '0', HOST: '127.0.0.1',
      SESSION_SECRET: 'test-only-session-secret', CRYPTO_SECRET: 'test-only-crypto-secret',
      SILENCE_HTTP_LOGS: 'true', DISABLE_NOTIFICATIONS_POLLING: 'true',
    };
    try {
      const migrated = await childRun(['bin/db_update.js'], env, 12000);
      assert.equal(migrated.code, 0, migrated.output);
      const observed = await childRun([__filename, '--runtime-child'], env, 12000);
      assert.equal(observed.code, 0, observed.output);
      assert.deepEqual(observed.messages.filter(message => message.type === 'runtime-check').map(message => message.step),
        ['ready', 'session', 'stopped']);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
});

if (process.argv.includes('--runtime-child')) {
  const runtime = startRuntime({
    sendReady: () => {},
    exit: code => { process.send({type: 'runtime-check', step: 'stopped'}); process.exitCode = code; },
  });
  runtime.start().then(async server => {
    process.send({type: 'runtime-check', step: 'ready'});
    const base = `http://127.0.0.1:${server.address().port}`;
    const first = await fetch(base + '/login/');
    assert.equal(first.status, 200);
    const cookie = first.headers.get('set-cookie');
    assert.ok(cookie && cookie.includes('connect.sid='));
    const second = await fetch(base + '/login/', {headers: {cookie: cookie.split(';')[0]}});
    assert.equal(second.status, 200);
    process.send({type: 'runtime-check', step: 'session'});
    await runtime.shutdown('sigterm', null, 0);
  }).catch(error => {
    process.stderr.write(String(error.stack || error));
    process.exitCode = 1;
  });
}
