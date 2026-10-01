#!/usr/bin/env node
'use strict';

/*
  Plan 08-1 measurement harness: records real durations for the lifecycle
  policies (startup, outage recovery, session probe, worker replacement,
  normal and forced shutdown) on the disposable runtime fixture services.

  Every scenario drives the production entrypoints (bin/wwww or
  bin/wwww_cluster) through the same preload the committed runtime matrix
  uses, so the numbers describe the shipped startup/shutdown code rather
  than a fixture-local runtime. Each mode prints one JSON line as its last
  stdout line; a parent watchdog owns every child process tree. The caller
  (plan execution or an operator) transcribes the observed numbers into
  t/fixtures/verify/runtime_timings.json — this harness never writes the
  timing fixture itself.
*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Sequelize = require('sequelize');
const {spawnInGroup, terminateTree} = require('../../../bin/lib/spawn_group');

const root = path.resolve(__dirname, '../../..');
const SETUP = 'docker compose -p leavepilot-runtime-test -f t/fixtures/runtime/services.compose.yml up -d --wait --wait-timeout 60';
const MYSQL_PREFIX = 'leavepilot_runtime_test_';
const MYSQL_HOST = '127.0.0.1';
const PORTS = {mysql: 13306, redis: 16379, engram: 16380};
// External observables are polled at this interval; detection/recovery
// numbers are therefore upper bounds with this granularity.
const POLL_MS = 50;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const childBaseEnv = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key])
  .map(key => [key, process.env[key]]));

// The preload is evaluated separately in every worker, before app.js loads.
// The cluster primary never loads the application or a selected Store.
if (process.env.TEST_RUNTIME_MATRIX_PRELOAD === '1') {
  if (process.env.TEST_RUNTIME_MATRIX_ENTRYPOINT !== 'cluster' || require('node:cluster').isWorker) {
    const config = require('../../../lib/config');
    const backend = process.env.TEST_RUNTIME_MATRIX_BACKEND;
    assert.ok(['sql', 'redis', 'engram'].includes(backend));
    config.set('sessionStore', backend === 'sql' ? {useRedis: false} : {
      useRedis: true,
      redisConnectionConfiguration: {
        host: MYSQL_HOST,
        port: Number(process.env.TEST_RUNTIME_MATRIX_STORE_PORT),
      },
    });
  }
} else if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

function exactInputs() {
  const env = process.env;
  assert.equal(env.DB_HOST, MYSQL_HOST, `Dedicated DB_HOST required. Setup: ${SETUP}`);
  assert.equal(Number(env.DB_PORT), PORTS.mysql, `Dedicated DB_PORT required. Setup: ${SETUP}`);
  assert.equal(env.DB_NAME, 'leavepilot_runtime_test', `Test-only DB_NAME required. Setup: ${SETUP}`);
  assert.equal(env.DB_USER, 'leavepilot_runtime_test', `Test-only DB_USER required. Setup: ${SETUP}`);
  assert.equal(env.DB_PASSWORD, 'runtime_test_only', `Test-only DB_PASSWORD required. Setup: ${SETUP}`);
  assert.equal(env.TEST_SESSION_HOST, MYSQL_HOST, `Dedicated TEST_SESSION_HOST required. Setup: ${SETUP}`);
  assert.equal(Number(env.TEST_REDIS_PORT), PORTS.redis, `Dedicated TEST_REDIS_PORT required. Setup: ${SETUP}`);
  assert.equal(Number(env.TEST_ENGRAM_PORT), PORTS.engram, `Dedicated TEST_ENGRAM_PORT required. Setup: ${SETUP}`);
}

async function pingResp(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({host: MYSQL_HOST, port});
    let response = '';
    const fail = () => { socket.destroy(); reject(new Error(`missing-prerequisite: RESP2 port ${port}. Setup: ${SETUP}`)); };
    socket.setTimeout(1500, fail);
    socket.once('error', fail);
    socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.on('data', chunk => {
      response += chunk.toString();
      if (response.includes('+PONG\r\n')) { socket.destroy(); resolve(); }
      else if (response.length > 64) { fail(); }
    });
  });
}

function sqlConnection(database, user, password) {
  return new Sequelize(database, user, password, {
    dialect: 'mysql', host: MYSQL_HOST, port: PORTS.mysql, logging: false,
    dialectOptions: {connectTimeout: 1500}, pool: {max: 1, min: 0, acquire: 2000},
  });
}

async function prerequisite(selections) {
  exactInputs();
  for (const selection of selections) {
    assert.ok(Object.hasOwn(PORTS, selection), 'Unknown prerequisite selection');
    if (selection === 'mysql') {
      const db = sqlConnection(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD);
      try { await db.authenticate(); }
      catch { throw new Error(`missing-prerequisite: MySQL 8 at ${MYSQL_HOST}:${PORTS.mysql}. Setup: ${SETUP}`); }
      finally { await db.close(); }
    } else { await pingResp(PORTS[selection]); }
  }
}

function neededServices(dialect, backend) {
  const selections = [];
  if (dialect === 'mysql') { selections.push('mysql'); }
  if (backend !== 'sql') { selections.push(backend); }
  return selections;
}

function child(argv, env, deadlineMs) {
  return new Promise((resolve, reject) => {
    const proc = spawnInGroup(process.execPath, argv, {
      cwd: root, env: {...childBaseEnv, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const record = chunk => { output = (output + chunk.toString()).slice(-5000); };
    proc.stdout.on('data', record);
    proc.stderr.on('data', record);
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(proc, {graceMs: 100}).catch(reject);
    }, deadlineMs);
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('close', code => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error(`Child exceeded ${deadlineMs}ms: ${output}`)); }
      else { resolve({code, output}); }
    });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, MYSQL_HOST, resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(port, route, cookie, options = {}) {
  const headers = {...options.headers};
  if (cookie) { headers.cookie = cookie; }
  // The readiness poll passes a short deadline so it can retry; authenticated
  // first-hit renders (template/i18n compile) get the wider default budget.
  // Neither clock participates in the startup/shutdown durations measured here.
  const signal = AbortSignal.timeout(options.timeoutMs || 5000);
  const result = await fetch(`http://${MYSQL_HOST}:${port}${route}`, {
    ...options, headers, redirect: 'manual', signal,
  });
  return {status: result.status, body: await result.text(),
    cookie: result.headers.getSetCookie().find(item => item.startsWith('connect.sid='))?.split(';')[0],
    location: result.headers.get('location'),
    workerPid: result.headers.get('x-test-worker-pid')};
}

function baseEnv(dialect, database, backend, entrypoint, port, storage, storePort) {
  return {
    NODE_ENV: 'test', TZ: 'UTC', DB_DIALECT: dialect, DB_NAME: database,
    DB_HOST: MYSQL_HOST, DB_PORT: String(PORTS.mysql), DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD, DB_STORAGE: storage, DB_LOGGING: 'false',
    PORT: String(port), HOST: MYSQL_HOST, SESSION_SECRET: 'matrix-only-session-secret',
    CRYPTO_SECRET: 'matrix-only-crypto-secret', SILENCE_HTTP_LOGS: 'true',
    DISABLE_AUTH_RATE_LIMIT: 'true', DISABLE_NOTIFICATIONS_POLLING: 'true',
    LEAVEPILOT_EDITION: 'community', TEST_RUNTIME_MATRIX_PRELOAD: '1',
    TEST_RUNTIME_MATRIX_BACKEND: backend, TEST_RUNTIME_MATRIX_ENTRYPOINT: entrypoint,
    TEST_RUNTIME_MATRIX_STORE_PORT: String(storePort === undefined ? PORTS[backend] || 0 : storePort),
  };
}

async function seed(env, email) {
  const result = await child(['-e', `
    const db = require('./lib/model/db');
    (async () => {
      await db.connect();
      const company = await db.Company.create({name:'Matrix',country:'GB',start_of_new_year:1});
      const department = await db.Department.create({name:'Test',companyId:company.id});
      const user = await db.User.create({name:'Test',lastname:'User',email:${JSON.stringify(email)},
        password:db.User.hashify_password('matrix-only-password'),companyId:company.id,
        DepartmentId:department.id,admin:true,activated:true});
      await department.update({bossId:user.id});
      await db.sequelize.close();
    })().catch(error => {console.error(error);process.exitCode=1;});
  `], env, 15000);
  assert.equal(result.code, 0, result.output);
}

async function withDatabase(dialect, operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-lifecycle-measure-'));
  const name = `${MYSQL_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
  assert.match(name, /^leavepilot_runtime_test_[a-f0-9]{12}$/);
  const storage = path.join(directory, 'app.sqlite');
  let admin;
  try {
    if (dialect === 'mysql') {
      admin = sqlConnection('leavepilot_runtime_test', 'root', 'runtime_root_test_only');
      await admin.query(`CREATE DATABASE \`${name}\``);
      await admin.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO 'leavepilot_runtime_test'@'%'`);
    }
    return await operation(name, storage);
  } finally {
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS \`${name}\``); }
      finally { await admin.close(); }
    }
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

// Boots the production entrypoint and resolves once the listener answers
// HTTP 200, which by design cannot happen before SQL and the selected
// Store are ready.
function bootRuntime({env, entrypoint, deadlineMs = 30000}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const entryScript = entrypoint === 'direct' ? 'bin/wwww' : 'bin/wwww_cluster';
    const proc = spawnInGroup(process.execPath, ['--require', __filename, entryScript], {
      cwd: root, env: {...childBaseEnv, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
    }
    const watchdog = setTimeout(() => {
      terminateTree(proc, {graceMs: 100}).catch(() => {});
      reject(new Error(`boot exceeded ${deadlineMs}ms: ${output}`));
    }, deadlineMs);
    const finish = (error, value) => {
      clearTimeout(watchdog);
      if (error) {
        terminateTree(proc, {graceMs: 100}).catch(() => {});
        reject(error);
      } else { resolve({...value, proc, output: () => output}); }
    };
    proc.once('error', error => finish(error));
    (async () => {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline && proc.exitCode === null) {
        try {
          const result = await request(Number(env.PORT), '/login/', null, {timeoutMs: 1500});
          if (result.status === 200) {
            finish(null, {startupMs: Date.now() - startedAt, page: result});
            return;
          }
        } catch { /* The listener stays closed until dependencies are ready. */ }
        await wait(POLL_MS);
      }
      finish(new Error(`runtime did not become ready: ${output}`));
    })().catch(finish);
  });
}

async function loginFlow(port, pageCookie, email) {
  const page = pageCookie ? {cookie: pageCookie} : await request(port, '/login/');
  const csrf = (await request(port, '/login/', page.cookie)).body
    .match(/name=["']_csrf["'][^>]*value=["']([^"']+)/i)?.[1];
  assert.ok(csrf, 'login page carried no CSRF token');
  const login = await request(port, '/login/', page.cookie, {
    method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf},
    body: new URLSearchParams({_csrf: csrf, email, password: 'matrix-only-password'}),
  });
  assert.equal(login.status, 302, 'login was not accepted');
  assert.match(login.cookie || '', /^connect\.sid=/);
  assert.equal((await request(port, '/calendar/', login.cookie)).status, 200, 'session cookie was not served');
  return login.cookie;
}

function stopRuntime(proc, deadlineMs = 20000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const watchdog = setTimeout(() => {
      terminateTree(proc, {graceMs: 100}).catch(() => {});
      reject(new Error(`shutdown exceeded ${deadlineMs}ms`));
    }, deadlineMs);
    proc.once('close', (code, signal) => {
      clearTimeout(watchdog);
      resolve({code, signal, shutdownMs: Date.now() - startedAt});
    });
    proc.kill('SIGTERM');
  });
}

// A minimal RESP2 interrupting proxy, mirroring the committed Redis
// lifecycle suite: only its own loopback sockets are touched.
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
    downstream.on('data', chunk => upstream.write(chunk));
    upstream.on('data', chunk => downstream.write(chunk));
  });
  return {
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

async function pollStatus(port, route, cookie, accepted, deadlineMs) {
  const startedAt = Date.now();
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const result = await request(port, route, cookie);
      if (accepted(result)) { return Date.now() - startedAt; }
    } catch { /* transitional connection state during an outage */ }
    await wait(POLL_MS);
  }
  throw new Error(`condition not reached within ${deadlineMs}ms`);
}

async function contourMeasurement(dialect, backend, entrypoint) {
  await prerequisite(neededServices(dialect, backend));
  return withDatabase(dialect, async (database, storage) => {
    const port = await freePort();
    const env = baseEnv(dialect, database, backend, entrypoint, port, storage);
    const migrationStart = Date.now();
    assert.equal((await child(['bin/db_update.js'], env, 30000)).code, 0, 'migration failed');
    const migrationMs = Date.now() - migrationStart;
    const email = `measure-${crypto.randomBytes(6).toString('hex')}@example.test`;
    await seed(env, email);

    const cold = await bootRuntime({env, entrypoint});
    const cookie = await loginFlow(port, cold.page.cookie, email);
    const coldStop = await stopRuntime(cold.proc);

    const warm = await bootRuntime({env, entrypoint});
    // A persisted session from the previous process must keep working after
    // the warm restart (SESS-01 restart compatibility observable).
    assert.equal((await request(port, '/calendar/', cookie)).status, 200,
      'persisted session did not survive the warm restart');
    const logout = await request(port, '/logout/', cookie);
    assert.equal(logout.status, 302, 'logout failed');
    const warmStop = await stopRuntime(warm.proc);

    assert.equal(coldStop.code, 0, `cold stop exited ${coldStop.code}`);
    assert.equal(warmStop.code, 0, `warm stop exited ${warmStop.code}`);
    return {mode: 'contour', dialect, backend, entrypoint, migrationMs,
      coldStartupMs: cold.startupMs, warmStartupMs: warm.startupMs,
      coldShutdownMs: coldStop.shutdownMs, warmShutdownMs: warmStop.shutdownMs};
  });
}

async function outageMeasurement(backend) {
  assert.ok(['redis', 'engram'].includes(backend));
  await prerequisite([backend]);
  const proxy = startProxy(MYSQL_HOST, PORTS[backend]);
  try {
    const proxyPort = await proxy.listen();
    return await withDatabase('sqlite', async (database, storage) => {
      const port = await freePort();
      const env = baseEnv('sqlite', database, backend, 'direct', port, storage, proxyPort);
      assert.equal((await child(['bin/db_update.js'], env, 30000)).code, 0, 'migration failed');
      const email = `outage-${crypto.randomBytes(6).toString('hex')}@example.test`;
      await seed(env, email);
      const boot = await bootRuntime({env, entrypoint: 'direct'});
      const cookie = await loginFlow(port, boot.page.cookie, email);
      const cycles = [];
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        proxy.setBlocked(true);
        const detectionMs = await pollStatus(port, '/calendar/', cookie,
          result => result.status === 503, 10000);
        assert.equal(boot.proc.exitCode, null, 'worker restarted during a bounded outage');
        proxy.setBlocked(false);
        const recoveryMs = await pollStatus(port, '/calendar/', cookie,
          result => result.status === 200, 15000);
        assert.equal(boot.proc.exitCode, null, 'worker restarted during recovery');
        cycles.push({cycle, outageDetectionMs: detectionMs, recoveryMs});
      }
      const stop = await stopRuntime(boot.proc);
      assert.equal(stop.code, 0, `normal stop exited ${stop.code}`);
      return {mode: 'outage', backend, dialect: 'sqlite', entrypoint: 'direct',
        startupMs: boot.startupMs, pollGranularityMs: POLL_MS, cycles,
        normalShutdownMs: stop.shutdownMs};
    });
  } finally { await proxy.close(); }
}

async function probeMeasurement(backend) {
  await prerequisite([backend]);
  const samples = [];
  for (let sample = 1; sample <= 2; sample += 1) {
    const result = await child([__filename, '--probe-child'], {
      NODE_ENV: 'test', TZ: 'UTC', SESSION_SECRET: 'probe-only-session-secret',
      CRYPTO_SECRET: 'probe-only-crypto-secret', PROBE_HOST: MYSQL_HOST,
      PROBE_PORT: String(PORTS[backend]), PROBE_BACKEND: backend,
    }, 20000);
    assert.equal(result.code, 0, result.output);
    const parsed = JSON.parse(result.output.trim().split('\n').at(-1));
    assert.equal(parsed.backend, backend);
    samples.push({identity: `sample-${sample}`, initializeMs: parsed.initializeMs});
  }
  return {mode: 'probe', backend,
    definition: 'createSessionMiddleware initialize() = RESP2 connect + public Store probe (set/get/touch/destroy + cleanup destroy)',
    samples};
}

// Runs inside the probe child: measures the real production middleware
// wiring (lib/middleware/withSession.js) against the selected service.
async function probeChild() {
  const config = require('../../../lib/config');
  config.set('sessionStore', {
    useRedis: true,
    redisConnectionConfiguration: {host: process.env.PROBE_HOST, port: Number(process.env.PROBE_PORT)},
  });
  const createSessionMiddleware = require('../../../lib/middleware/withSession');
  const middleware = createSessionMiddleware({});
  const lifecycle = middleware.sessionLifecycle;
  const startedAt = Date.now();
  try {
    await lifecycle.initialize();
    const initializeMs = Date.now() - startedAt;
    process.stdout.write(JSON.stringify({backend: process.env.PROBE_BACKEND, initializeMs}) + '\n');
  } finally { await lifecycle.close(); }
}

async function replacementMeasurement(dialect, backend) {
  await prerequisite(neededServices(dialect, backend));
  return withDatabase(dialect, async (database, storage) => {
    const port = await freePort();
    const env = baseEnv(dialect, database, backend, 'cluster', port, storage);
    assert.equal((await child(['bin/db_update.js'], env, 30000)).code, 0, 'migration failed');
    const email = `replace-${crypto.randomBytes(6).toString('hex')}@example.test`;
    await seed(env, email);
    const result = await new Promise((resolve, reject) => {
      // t/fixtures/runtime/cluster_case.js is the real bin/wwww_cluster with
      // IPC readiness reporting and per-worker response tagging.
      const proc = spawnInGroup(process.execPath, ['--require', __filename,
        't/fixtures/runtime/cluster_case.js'], {
        cwd: root, env: {...childBaseEnv, ...env}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const messages = [];
      let output = '';
      const watchdog = setTimeout(() => {
        terminateTree(proc, {graceMs: 100}).catch(() => {});
        reject(new Error(`cluster scenario exceeded its watchdog: ${output}`));
      }, 45000);
      proc.on('message', message => messages.push({...message, at: Date.now()}));
      for (const stream of [proc.stdout, proc.stderr]) {
        stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
      }
      proc.once('error', error => { clearTimeout(watchdog); reject(error); });
      (async () => {
        const ready = () => messages.filter(message => message.type === 'cluster-ready');
        const deadline = Date.now() + 30000;
        while (ready().length < 2 && Date.now() < deadline && proc.exitCode === null) {
          await wait(POLL_MS);
        }
        assert.equal(ready().length >= 2, true, `two workers did not become ready: ${output}`);
        const cookie = await loginFlow(port, null, email);
        // Keep-alive pins a connection to one worker; closing each request
        // lets the supervisor's socket distribution be observed per worker.
        const served = await request(port, '/login/', cookie, {headers: {connection: 'close'}});
        const victimPid = Number(served.workerPid);
        const victim = ready().find(message => message.pid === victimPid);
        assert.ok(victim, `serving worker ${victimPid} never reported ready`);
        const killedAt = Date.now();
        proc.send({type: 'kill-worker', workerId: victim.workerId});
        const replacementDeadline = Date.now() + 15000;
        while (ready().length < 3 && Date.now() < replacementDeadline && proc.exitCode === null) {
          await wait(POLL_MS);
        }
        assert.equal(ready().length >= 3, true, `replacement worker did not become ready: ${output}`);
        const replacement = ready()[2];
        assert.notEqual(replacement.pid, victim.pid, 'worker was not replaced');
        const replacementMs = replacement.at - killedAt;
        const serveDeadline = Date.now() + 10000;
        let servedByReplacement = false;
        while (!servedByReplacement && Date.now() < serveDeadline) {
          const probe = await request(port, '/login/', cookie, {headers: {connection: 'close'}});
          servedByReplacement = probe.status === 200 && Number(probe.workerPid) === replacement.pid;
          await wait(POLL_MS);
        }
        assert.equal(servedByReplacement, true, 'replacement worker did not serve traffic');
        const stopStart = Date.now();
        proc.kill('SIGTERM');
        const closed = await new Promise(resolve => proc.once('close', (code, signal) => resolve({code, signal})));
        const supervisorStopMs = Date.now() - stopStart;
        assert.equal(closed.code, 0, `cluster stop exited ${closed.code} by ${closed.signal}: ${output}`);
        clearTimeout(watchdog);
        const workerPids = [...new Set(ready().map(message => message.pid))];
        resolve({workerPids, supervisorStopMs, replacementMs, proc});
      })().catch(error => {
        clearTimeout(watchdog);
        terminateTree(proc, {graceMs: 100}).catch(() => {});
        reject(error);
      });
    });
    // No owned worker may survive the supervisor exit.
    for (const pid of result.workerPids) {
      try { process.kill(pid, 0); throw new Error(`worker ${pid} survived the supervisor`); }
      catch (error) { assert.equal(error.code, 'ESRCH', `worker ${pid} check failed`); }
    }
    await terminateTree(result.proc, {graceMs: 100});
    return {mode: 'replacement', dialect, backend, entrypoint: 'cluster',
      workerReplacementMs: result.replacementMs, supervisorStopMs: result.supervisorStopMs};
  });
}

async function faultMeasurement(dialect, fault, entrypoint) {
  assert.ok(['schema', 'credentials'].includes(fault));
  if (fault === 'credentials') { assert.equal(dialect, 'mysql'); }
  await prerequisite(['mysql']);
  return withDatabase(dialect, async (database, storage) => {
    const port = await freePort();
    const env = baseEnv(dialect, database, 'sql', entrypoint, port, storage);
    if (fault === 'credentials') {
      assert.equal((await child(['bin/db_update.js'], env, 30000)).code, 0, 'migration failed');
      env.DB_PASSWORD = 'invalid-test-only-password';
    }
    const startedAt = Date.now();
    const result = await child(['--require', __filename,
      entrypoint === 'direct' ? 'bin/wwww' : 'bin/wwww_cluster'], env, 20000);
    const faultExitMs = Date.now() - startedAt;
    assert.equal(result.code, 1, `fault case exited ${result.code}`);
    await assert.rejects(request(port, '/login/'), /fetch failed/i, 'listener was opened');
    return {mode: 'fault', dialect, fault, entrypoint, faultExitMs, exitCode: result.code};
  });
}

// A real in-flight request with a slowly-trickled body keeps HTTP admission
// from finishing, so the production 10000 ms shutdown budget must expire and
// report the stop as incomplete (nonzero) instead of hanging or lying.
async function forcedMeasurement() {
  return withDatabase('sqlite', async (database, storage) => {
    const port = await freePort();
    const env = baseEnv('sqlite', database, 'sql', 'direct', port, storage);
    assert.equal((await child(['bin/db_update.js'], env, 30000)).code, 0, 'migration failed');
    const boot = await bootRuntime({env, entrypoint: 'direct'});
    const socket = net.connect({host: MYSQL_HOST, port});
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', resolve);
    });
    const headers = 'POST /login/ HTTP/1.1\r\n'
      + `Host: ${MYSQL_HOST}:${port}\r\n`
      + 'Content-Type: application/x-www-form-urlencoded\r\n'
      + 'Content-Length: 1048576\r\n\r\n';
    socket.write(headers + 'x'.repeat(8192));
    const trickle = setInterval(() => {
      try { socket.write('y'.repeat(8192)); } catch { /* already closed */ }
    }, 1500);
    try {
      await wait(1000);
      assert.equal(boot.proc.exitCode, null, 'worker exited before the signal');
      const stop = await stopRuntime(boot.proc, 20000);
      return {mode: 'forced', dialect: 'sqlite', backend: 'sql', entrypoint: 'direct',
        forcedShutdownMs: stop.shutdownMs, exitCode: stop.code, incomplete: stop.code !== 0};
    } finally {
      clearInterval(trickle);
      socket.destroy();
      await terminateTree(boot.proc, {graceMs: 100});
    }
  });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--probe-child') { await probeChild(); return; }
  if (mode === '--contour') { process.stdout.write(JSON.stringify(await contourMeasurement(args[0], args[1], args[2])) + '\n'); return; }
  if (mode === '--outage') { process.stdout.write(JSON.stringify(await outageMeasurement(args[0])) + '\n'); return; }
  if (mode === '--probe') { process.stdout.write(JSON.stringify(await probeMeasurement(args[0])) + '\n'); return; }
  if (mode === '--replacement') { process.stdout.write(JSON.stringify(await replacementMeasurement(args[0], args[1])) + '\n'); return; }
  if (mode === '--fault') { process.stdout.write(JSON.stringify(await faultMeasurement(args[0], args[1], args[2])) + '\n'); return; }
  if (mode === '--forced') { process.stdout.write(JSON.stringify(await forcedMeasurement()) + '\n'); return; }
  throw new Error('Usage: lifecycle_measurements.js --contour <dialect> <backend> <direct|cluster> | --outage <redis|engram> | --probe <redis|engram> | --replacement <dialect> <backend> | --fault <dialect> <schema|credentials> <direct|cluster> | --forced');
}

module.exports = {contourMeasurement, outageMeasurement, probeMeasurement,
  replacementMeasurement, faultMeasurement, forcedMeasurement};
