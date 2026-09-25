'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {spawnInGroup, terminateTree} = require('../../bin/lib/spawn_group');

const OWNERSHIP_KEY = 'lp:phase02:session-owner';
const setup = 'Start a dedicated Redis/RESP2 service; SET lp:phase02:session-owner to a unique token; set TEST_SESSION_HOST, TEST_SESSION_PORT, TEST_SESSION_BACKEND=redis and TEST_SESSION_OWNERSHIP_TOKEN to that token';
const fixture = path.resolve(__dirname, '../fixtures/runtime/redis_session_case.js');

function waitFor(run, event, timeoutMs = 5000) {
  const prior = run.events.find(item => item.event === event);
  if (prior) { return Promise.resolve(prior); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      run.waiters.delete(receive);
      reject(new Error(`Timed out waiting for ${event}: ${run.output}`));
    }, timeoutMs);
    const receive = message => {
      if (message.event !== event) { return; }
      clearTimeout(timer);
      run.waiters.delete(receive);
      resolve(message);
    };
    run.waiters.add(receive);
  });
}

function startProxy(host, port) {
  const sockets = new Set();
  let blocked = false;
  const server = net.createServer(downstream => {
    sockets.add(downstream);
    downstream.on('close', () => sockets.delete(downstream));
    if (blocked) { downstream.destroy(); return; }
    const upstream = net.connect(port, host);
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    downstream.pipe(upstream).pipe(downstream);
  });
  return {
    server,
    setBlocked(value) {
      blocked = value;
      if (blocked) { for (const socket of sockets) { socket.destroy(); } }
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      return server.address().port;
    },
    async close() {
      for (const socket of sockets) { socket.destroy(); }
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function checkEndpoint(host, port) {
  const token = process.env.TEST_SESSION_OWNERSHIP_TOKEN;
  if (!host || !Number.isInteger(port) || port <= 0 || process.env.TEST_SESSION_BACKEND !== 'redis'
      || !token || !/^[A-Za-z0-9]{16,64}$/.test(token)) {
    throw new Error(setup);
  }
  await new Promise((resolve, reject) => {
    const socket = net.connect({host, port});
    let response = '';
    let finished = false;
    const finish = valid => {
      if (finished) { return; }
      finished = true;
      socket.destroy();
      valid ? resolve() : reject(new Error(setup));
    };
    const expected = `$${token.length}\r\n${token}\r\n`;
    const command = `*2\r\n$3\r\nGET\r\n$${OWNERSHIP_KEY.length}\r\n${OWNERSHIP_KEY}\r\n`;
    const fail = () => finish(false);
    socket.setTimeout(1000, fail);
    socket.once('error', fail);
    socket.on('connect', () => socket.write(command));
    socket.on('data', chunk => {
      response += chunk.toString();
      if (response === expected) { finish(true); }
      else if (response.length >= expected.length) { finish(false); }
    });
  });
}

function launch(env) {
  const child = spawnInGroup(process.execPath, [fixture], {
    cwd: path.resolve(__dirname, '../..'), env: {...process.env, ...env},
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const run = {child, events: [], waiters: new Set(), output: ''};
  child.on('message', message => {
    run.events.push(message);
    for (const waiter of run.waiters) { waiter(message); }
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { run.output = (run.output + chunk.toString()).slice(-6000); });
  }
  run.closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  return run;
}

async function request(base, route, cookie, options = {}) {
  const headers = {...options.headers};
  if (cookie) { headers.cookie = cookie; }
  const response = await fetch(base + route, {...options, headers, redirect: 'manual', signal: AbortSignal.timeout(3000)});
  const body = await response.text();
  return {status: response.status, body, location: response.headers.get('location'),
    cookie: response.headers.getSetCookie().find(value => value.startsWith('connect.sid='))};
}

function selectedCookie(response) {
  return response.cookie && response.cookie.split(';')[0];
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Condition did not become true within deadline');
}

describe('real Redis session lifecycle', function() {
  it('recovery tracer: retains authenticated SID through TCP loss and same-PID recovery', async function() {
    this.timeout(10000);
    const host = process.env.TEST_SESSION_HOST;
    const port = Number(process.env.TEST_SESSION_PORT);
    await checkEndpoint(host, port);
    const proxy = startProxy(host, port);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-redis-lifecycle-'));
    let run;
    try {
      const proxyPort = await proxy.listen();
      run = launch({NODE_ENV: 'test', DB_DIALECT: 'sqlite', DB_STORAGE: path.join(directory, 'app.sqlite'),
        DB_LOGGING: 'false', SESSION_SECRET: 'redis-lifecycle-session-secret',
        CRYPTO_SECRET: 'redis-lifecycle-crypto-secret', SILENCE_HTTP_LOGS: 'true',
        DISABLE_AUTH_RATE_LIMIT: 'true', DISABLE_NOTIFICATIONS_POLLING: 'true',
        LEAVEPILOT_EDITION: 'community', TEST_SESSION_HOST: '127.0.0.1',
        TEST_SESSION_PORT: String(proxyPort), TEST_SESSION_BACKEND: 'redis'});
      const ready = await waitFor(run, 'ready');
      const base = `http://127.0.0.1:${ready.port}`;
      const page = await request(base, '/login/');
      assert.equal(page.status, 200, run.output);
      const csrf = page.body.match(/name=["']_csrf["'][^>]*value=["']([^"']+)/i)?.[1];
      assert.ok(csrf);
      const login = await request(base, '/login/', selectedCookie(page), {
        method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf},
        body: new URLSearchParams({_csrf: csrf, email: 'redis-lifecycle@example.test', password: 'test123'}),
      });
      assert.equal(login.status, 302, run.output);
      assert.equal(login.location, '/', run.output);
      const cookie = selectedCookie(login);
      assert.ok(cookie);
      const before = await request(base, '/calendar/', cookie);
      assert.equal(before.status, 200, run.output);
      proxy.setBlocked(true);
      await waitFor(run, 'session-unready', 2000);
      assert.equal((await request(base, '/', cookie)).status, 503);
      assert.equal((await request(base, '/calendar/', cookie)).status, 503);
      proxy.setBlocked(false);
      await waitUntil(() => run.events.filter(item => item.event === 'session-ready').length >= 2);
      assert.equal(run.child.exitCode, null);
      const after = await request(base, '/calendar/', cookie);
      assert.equal(after.status, 200, run.output);
      assert.equal(ready.pid, run.child.pid);
      assert.equal(selectedCookie(after) || cookie, cookie);
      assert.equal(run.events.filter(item => item.event === 'exit').length, 0);
    } finally {
      if (run) { await terminateTree(run.child, {graceMs: 100}); }
      await proxy.close();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('recovery tracer: exits nonzero when the selected Store stays unavailable', async function() {
    this.timeout(10000);
    const host = process.env.TEST_SESSION_HOST;
    const port = Number(process.env.TEST_SESSION_PORT);
    await checkEndpoint(host, port);
    const proxy = startProxy(host, port);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-redis-deadline-'));
    let run;
    try {
      const proxyPort = await proxy.listen();
      run = launch({NODE_ENV: 'test', DB_DIALECT: 'sqlite', DB_STORAGE: path.join(directory, 'app.sqlite'),
        DB_LOGGING: 'false', SESSION_SECRET: 'redis-lifecycle-session-secret',
        CRYPTO_SECRET: 'redis-lifecycle-crypto-secret', SILENCE_HTTP_LOGS: 'true',
        DISABLE_AUTH_RATE_LIMIT: 'true', DISABLE_NOTIFICATIONS_POLLING: 'true',
        LEAVEPILOT_EDITION: 'community', TEST_SESSION_HOST: '127.0.0.1',
        TEST_SESSION_PORT: String(proxyPort), TEST_SESSION_BACKEND: 'redis',
        TEST_SESSION_RECOVERY_MS: '350'});
      const ready = await waitFor(run, 'ready');
      const base = `http://127.0.0.1:${ready.port}`;
      assert.equal((await request(base, '/login/')).status, 200);
      proxy.setBlocked(true);
      await waitFor(run, 'session-unready', 2000);
      assert.equal((await request(base, '/')).status, 503);
      let watchdog;
      const result = await Promise.race([
        run.closed,
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('worker did not exit')), 3000);
        }),
      ]).finally(() => clearTimeout(watchdog));
      assert.equal(result.code, 1, run.output);
      assert.equal(run.events.filter(item => item.event === 'session-failed').length, 1);
      assert.equal(run.events.filter(item => item.event === 'exit').length, 1);
    } finally {
      if (run) { await terminateTree(run.child, {graceMs: 100}); }
      await proxy.close();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
});
