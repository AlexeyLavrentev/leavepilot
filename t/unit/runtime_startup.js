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
    assertSchemaReady: async () => { events.push('db.schema'); },
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
  return {runtime, events, gate, lifecycle, db, notify: state => notify(state), subscription: () => ({subscribed, unsubscribed})};
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

if (!process.argv.includes('--runtime-child')) { describe('direct runtime startup owner', function() {
  it('retries only allowlisted connection failures before one absolute deadline', async function() {
    const fixture = makeRuntime({startupTimeoutMs: 180, retryDelayMs: 5});
    let attempts = 0;
    fixture.db.connect = async () => {
      fixture.events.push('db.connect');
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('temporary'), {parent: {code: attempts === 1 ? 'ECONNREFUSED' : 'EAI_AGAIN'}});
      }
    };
    fixture.gate.release();
    await fixture.runtime.start();
    assert.equal(attempts, 3);
    assert.ok(fixture.events.indexOf('db.schema') < fixture.events.indexOf('listen'));
    await fixture.runtime.shutdown('sigterm', null, 0);
  });

  it('rejects auth, schema, config and unknown errors without retries', async function() {
    for (const error of [
      Object.assign(new Error('denied'), {parent: {code: 'ER_ACCESS_DENIED_ERROR'}}),
      Object.assign(new Error('schema'), {code: 'ER_NO_SUCH_TABLE'}),
      Object.assign(new Error('invalid config'), {code: 'ERR_INVALID_ARG_TYPE'}),
      new Error('ECONNREFUSED in message only'),
    ]) {
      const fixture = makeRuntime({startupTimeoutMs: 100, retryDelayMs: 5});
      let attempts = 0;
      fixture.db.connect = async () => { attempts += 1; throw error; };
      await fixture.runtime.start();
      await fixture.runtime.whenStopped();
      assert.equal(attempts, 1, error.message);
      assert.equal(fixture.events.includes('listen'), false);
      assert.equal(fixture.events.filter(event => event === 'exit:1').length, 1);
    }
  });

  it('bounds a never-settling connection and does not listen after late success', async function() {
    const fixture = makeRuntime({startupTimeoutMs: 35, retryDelayMs: 5});
    let release;
    fixture.db.connect = () => new Promise(resolve => { release = resolve; });
    const starting = fixture.runtime.start();
    await fixture.runtime.whenStopped();
    release();
    await starting;
    assert.equal(fixture.events.includes('listen'), false);
    assert.equal(fixture.events.filter(event => event === 'exit:1').length, 1);
  });

  it('shares the budget across SQL, schema and Store retries', async function() {
    const fixture = makeRuntime({startupTimeoutMs: 55, retryDelayMs: 20});
    fixture.db.connect = async () => {
      fixture.events.push('db.connect');
      await wait(30);
    };
    fixture.db.assertSchemaReady = async () => {
      fixture.events.push('db.schema');
      throw Object.assign(new Error('reset'), {code: 'ECONNRESET'});
    };
    const started = Date.now();
    await fixture.runtime.start();
    await fixture.runtime.whenStopped();
    assert.ok(Date.now() - started < 130);
    assert.equal(fixture.events.includes('listen'), false);
    assert.equal(fixture.events.filter(event => event === 'exit:1').length, 1);
  });

  it('fails once on a listener error after readiness', async function() {
    const fixture = makeRuntime({listen: async () => { throw Object.assign(new Error('busy'), {code: 'EADDRINUSE'}); }});
    fixture.gate.release();
    await fixture.runtime.start();
    await fixture.runtime.whenStopped();
    assert.equal(fixture.events.includes('ready'), false);
    assert.equal(fixture.events.filter(event => event === 'exit:1').length, 1);
  });

  it('rejects invalid injected startup budgets', function() {
    for (const startupTimeoutMs of [0, -1, Infinity, NaN, '20']) {
      assert.throws(() => makeRuntime({startupTimeoutMs}), /startupTimeoutMs/);
    }
  });
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

  it('bounds a stalled selected Store and never accepts its late completion', async function() {
    const {runtime, events, gate} = makeRuntime({startupTimeoutMs: 30});
    const starting = runtime.start();
    await wait(60);
    await runtime.whenStopped();
    gate.release();
    await starting;
    assert.equal(events.includes('listen'), false);
    assert.equal(events.includes('ready'), false);
    assert.equal(events.filter(event => event === 'exit:1').length, 1);
  });

  it('lets failed initialization own one terminal result', async function() {
    const fixture = makeRuntime();
    fixture.lifecycle.initialize = async () => { throw new Error('store-init-failed'); };
    await fixture.runtime.start();
    await fixture.runtime.whenStopped();
    assert.equal(fixture.events.includes('listen'), false);
    assert.equal(fixture.events.includes('ready'), false);
    assert.equal(fixture.events.filter(event => event === 'db.close').length, 1);
    assert.equal(fixture.events.filter(event => event === 'exit:1').length, 1);
    assert.deepEqual(fixture.subscription(), {subscribed: 1, unsubscribed: 1});
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

  it('keeps the first fatal outcome when a signal and queued state callback follow', async function() {
    const {runtime, events, gate, notify} = makeRuntime();
    gate.release();
    await runtime.start();
    notify({state: 'failed', error: new Error('store unavailable')});
    await runtime.shutdown('sigterm', null, 0);
    await runtime.whenStopped();
    notify({state: 'ready'});
    assert.equal(events.filter(event => event === 'exit:1').length, 1);
    assert.equal(events.filter(event => event === 'exit:0').length, 0);
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
      const failed = await childRun([__filename, '--runtime-child'], {...env, RUNTIME_CASE: 'store-failure'}, 12000);
      assert.equal(failed.code, 1, failed.output);
      assert.deepEqual(failed.messages.filter(message => message.type === 'runtime-check').map(message => message.step),
        ['ready', 'session', 'stopped']);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
}); }

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
    if (process.env.RUNTIME_CASE === 'store-failure') {
      const lifecycle = require('../../app').get('session_middleware').sessionLifecycle;
      lifecycle.reportFailure(new Error('injected-store-failure'));
      lifecycle.reportFailure(new Error('duplicate-store-failure'));
      await runtime.whenStopped();
    } else {
      await runtime.shutdown('sigterm', null, 0);
    }
  }).catch(error => {
    process.stderr.write(String(error.stack || error));
    process.exitCode = 1;
  });
}
