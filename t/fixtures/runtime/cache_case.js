#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Sequelize = require('sequelize');
const {createClient} = require('redis');
const {spawnInGroup, terminateTree} = require('../../../bin/lib/spawn_group');

const root = path.resolve(__dirname, '../../..');
const SETUP = 'docker compose -p leavepilot-runtime-test -f t/fixtures/runtime/services.compose.yml up -d --wait --wait-timeout 60';
const MYSQL_PREFIX = 'leavepilot_runtime_test_';
const HOST = '127.0.0.1';
const PORTS = {mysql: 13306, redis: 16379, engram: 16380};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const childBaseEnv = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key])
  .map(key => [key, process.env[key]]));

// Evaluated in the primary and in every worker before bin/wwww_cluster loads
// the application. The primary keeps the cluster_case.js import guard (it must
// never load application, cache or model code); every worker points BOTH the
// session store and the team-view cache at the shared Redis fixture through the
// nconf seam and stamps X-Test-Worker-Pid so the case can target workers.
if (process.env.TEST_CACHE_CASE_PRELOAD === '1') {
  if (require('node:cluster').isPrimary) {
    const Module = require('node:module');
    const forbidden = /(?:^|\/)(?:app\.js|withSession\.js|team_view_cache\.js|runtime_startup\.js|runtime_shutdown\.js|scheduler\/|model\/db\/)/;
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (forbidden.test(resolved)) {
        throw new Error(`primary_import_forbidden:${resolved}`);
      }
      return originalLoad.apply(this, arguments);
    };
  } else {
    const http = require('node:http');
    const originalEmit = http.Server.prototype.emit;
    http.Server.prototype.emit = function(event, request, response) {
      if (event === 'request') {
        response.setHeader('X-Test-Worker-Pid', String(process.pid));
      }
      return originalEmit.apply(this, arguments);
    };
    const config = require('../../../lib/config');
    config.set('sessionStore', {
      useRedis: true,
      redisConnectionConfiguration: {host: HOST, port: PORTS.redis},
    });
  }
} else if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

function exactInputs() {
  const env = process.env;
  assert.equal(env.TEST_SESSION_HOST, HOST, `Dedicated TEST_SESSION_HOST required. Setup: ${SETUP}`);
  assert.equal(Number(env.TEST_REDIS_PORT), PORTS.redis, `Dedicated TEST_REDIS_PORT required. Setup: ${SETUP}`);
}

async function pingResp(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({host: HOST, port});
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
    dialect: 'mysql', host: HOST, port: PORTS.mysql, logging: false,
    dialectOptions: {connectTimeout: 1500}, pool: {max: 1, min: 0, acquire: 2000},
  });
}

async function prerequisite(selection = 'redis') {
  exactInputs();
  assert.ok(Object.hasOwn(PORTS, selection), 'Unknown prerequisite selection');
  await pingResp(PORTS[selection]);
  process.stdout.write(`${selection} ready\n`);
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
  await new Promise(resolve => server.listen(0, HOST, resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(port, route, cookie, options = {}) {
  const headers = {...options.headers, connection: 'close'};
  if (cookie) { headers.cookie = cookie; }
  const result = await fetch(`http://${HOST}:${port}${route}`, {
    ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(1500),
  });
  return {status: result.status, body: await result.text(),
    cookie: result.headers.getSetCookie().find(item => item.startsWith('connect.sid='))?.split(';')[0],
    location: result.headers.get('location'),
    workerPid: result.headers.get('x-test-worker-pid')};
}

// Repeat requests on fresh connections (cluster round-robin hands each new
// connection to the next worker) until the wanted worker serves one.
async function requestFromWorker(port, wantedPid, route, cookie, options = {}) {
  const deadline = Date.now() + 15000;
  let last = null;
  while (Date.now() < deadline) {
    last = await request(port, route, cookie, options);
    if (String(last.workerPid) === String(wantedPid)) { return last; }
    await wait(50);
  }
  throw new Error(`worker ${wantedPid} did not serve ${route} (last ${last && last.workerPid})`);
}

async function discoverWorkers(port) {
  const deadline = Date.now() + 15000;
  const pids = new Set();
  while (Date.now() < deadline && pids.size < 2) {
    const result = await request(port, '/login/');
    if (result.workerPid) { pids.add(result.workerPid); }
    if (pids.size < 2) { await wait(100); }
  }
  assert.equal(pids.size, 2, 'expected two cluster workers serving requests');
  return [...pids];
}

async function ready(port, proc, output) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline && proc.exitCode === null) {
    try {
      const result = await request(port, '/login/');
      if (result.status === 200) { return result; }
    } catch { /* The listener is deliberately closed until dependencies are ready. */ }
    await wait(100);
  }
  throw new Error(`runtime did not become ready: ${output()}`);
}

function baseEnv(dialect, database, port, storage) {
  return {
    NODE_ENV: 'test', TZ: 'UTC', DB_DIALECT: dialect, DB_NAME: database,
    DB_HOST: HOST, DB_PORT: String(PORTS.mysql), DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD, DB_STORAGE: storage, DB_LOGGING: 'false',
    PORT: String(port), HOST: HOST, SESSION_SECRET: 'cache-case-only-session-secret',
    CRYPTO_SECRET: 'cache-case-only-crypto-secret', SILENCE_HTTP_LOGS: 'true',
    DISABLE_AUTH_RATE_LIMIT: 'true', DISABLE_NOTIFICATIONS_POLLING: 'true',
    SILENCE_PRETEND_EMAILS: 'true', LEAVEPILOT_EDITION: 'community',
    TEST_CACHE_CASE_PRELOAD: '1',
  };
}

async function seed(env, viewerEmail, leaverEmail) {
  const result = await child(['-e', `
    const db = require('./lib/model/db');
    (async () => {
      await db.connect();
      const company = await db.Company.create({name:'CacheCase',country:'GB',start_of_new_year:1});
      const department = await db.Department.create({name:'Test',companyId:company.id});
      const leaveType = await db.LeaveType.create({name:'Holiday',color:'#008000',companyId:company.id});
      const build = (name,email,admin) => ({name,lastname:'User',email,
        password:db.User.hashify_password('cache-case-only-password'),
        companyId:company.id,DepartmentId:department.id,admin,activated:true});
      const viewer = await db.User.create(build('Viewer',${JSON.stringify(viewerEmail)},true));
      await db.User.create(build('Leaver',${JSON.stringify(leaverEmail)},false));
      await department.update({bossId:viewer.id});
      await db.sequelize.close();
      console.log(JSON.stringify({companyId:company.id,leaveTypeId:leaveType.id}));
    })().catch(error => {console.error(error);process.exitCode=1;});
  `], env, 12000);
  assert.equal(result.code, 0, result.output);
  const line = result.output.trim().split('\n').find(candidate => candidate.startsWith('{"companyId"'));
  assert.ok(line, result.output);
  return JSON.parse(line);
}

async function login(port, email) {
  const page = await request(port, '/login/');
  assert.equal(page.status, 200);
  const csrf = extractCsrf(page.body);
  assert.ok(csrf);
  const result = await request(port, '/login/', page.cookie, {
    method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf},
    body: new URLSearchParams({_csrf: csrf, email, password: 'cache-case-only-password'}),
  });
  assert.equal(result.status, 302);
  assert.match(result.cookie || '', /^connect\.sid=/);
  return {cookie: result.cookie};
}

function extractCsrf(body) {
  return body.match(/name=["']_csrf["'][^>]*value=["']([^"']+)/i)?.[1];
}

async function withDatabase(dialect, operation) {
  assert.equal(dialect, 'mysql');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cache-case-'));
  const name = `${MYSQL_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
  assert.match(name, /^leavepilot_runtime_test_[a-f0-9]{12}$/);
  const storage = path.join(directory, 'app.sqlite');
  let admin;
  try {
    admin = sqlConnection('leavepilot_runtime_test', 'root', 'runtime_root_test_only');
    await admin.query(`CREATE DATABASE \`${name}\``);
    await admin.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO 'leavepilot_runtime_test'@'%'`);
    await operation(name, storage, admin);
  } finally {
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS \`${name}\``); }
      finally { await admin.close(); }
    }
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

async function runShared() {
  await prerequisite('redis');
  await withDatabase('mysql', async (database, storage, admin) => {
    const port = await freePort();
    const env = baseEnv('mysql', database, port, storage);
    const migration = await child(['bin/db_update.js'], env, 20000);
    assert.equal(migration.code, 0, migration.output);
    const viewerEmail = `cache-viewer-${crypto.randomBytes(6).toString('hex')}@example.test`;
    const leaverEmail = `cache-leaver-${crypto.randomBytes(6).toString('hex')}@example.test`;
    const seeded = await seed(env, viewerEmail, leaverEmail);

    const proc = spawnInGroup(process.execPath, ['--require', __filename, 'bin/wwww_cluster'], {
      cwd: root, env: {...childBaseEnv, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
    }
    const watchdog = setTimeout(() => { terminateTree(proc, {graceMs: 100}).catch(() => {}); }, 60000);

    const redis = createClient({socket: {host: HOST, port: PORTS.redis}, RESP: 2});
    redis.on('error', () => {});
    try {
      await ready(port, proc, () => output);
      await redis.connect();
      const [workerA, workerB] = await discoverWorkers(port);
      const viewer = await login(port, viewerEmail);

      // Consume the login flash on a plain page first: a flash-carrying team
      // view request must never be cached.
      await request(port, '/calendar/', viewer.cookie);

      // Warm the SAME viewer's team view through BOTH workers (cache keys
      // embed user_id, so warming with another user would never hit).
      const today = new Date().toISOString().slice(0, 10);
      const teamviewRoute = `/calendar/teamview/?date=${today}`;
      const warmStartedAt = Date.now();
      const warmA = await requestFromWorker(port, workerA, teamviewRoute, viewer.cookie);
      const warmB = await requestFromWorker(port, workerB, teamviewRoute, viewer.cookie);
      assert.equal(warmA.status, 200, output);
      assert.equal(warmB.status, 200, output);

      // The warmed entry and the company version must live in the shared store.
      const warmedKeys = await redis.keys('teamview:*');
      const hasWarmedEntry = warmedKeys.some(key => key.startsWith('teamview:{'));
      assert.ok(hasWarmedEntry, `no warmed team-view entry in Redis: ${warmedKeys.join(',')}`);
      const versionKey = `teamview:version:${seeded.companyId}`;
      const versionBefore = await redis.get(versionKey);
      assert.ok(versionBefore, `company version missing from Redis: ${versionKey}`);
      const versionBeforeNumber = Number(versionBefore);

      // Mutate through one worker: the leaver books today off.
      const leaver = await login(port, leaverEmail);
      await request(port, '/calendar/', leaver.cookie);
      const csrf = extractCsrf((await request(port, '/calendar/', leaver.cookie)).body);
      assert.ok(csrf);
      const booking = await request(port, '/calendar/bookleave/', leaver.cookie, {
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf},
        body: new URLSearchParams({
          _csrf: csrf,
          leave_type: String(seeded.leaveTypeId),
          from_date: today,
          from_date_part: '1',
          to_date: today,
          to_date_part: '1',
          reason: 'cache case proof',
        }),
      });
      assert.equal(booking.status, 302, `${booking.body}\n${output}`);
      const bookingWorker = booking.workerPid;
      assert.ok(bookingWorker);

      const [leaveRow] = await admin.query('SELECT id FROM `Leaves` ORDER BY id DESC LIMIT 1');
      assert.ok(leaveRow && leaveRow.id, `no leave row after booking: ${output}`);

      // Read through the OTHER worker well inside the 30 s TTL: only the
      // shared version advance (post-commit hook) can explain freshness.
      const readWorker = bookingWorker === String(workerA) ? workerB : workerA;
      const finalRead = await requestFromWorker(port, readWorker, teamviewRoute, viewer.cookie);
      assert.equal(finalRead.status, 200, output);
      const leaveVisible = finalRead.body.includes(`data-leave-id="${leaveRow.id}"`);
      const versionAfter = await redis.get(versionKey);
      assert.ok(versionAfter, `company version missing after booking: ${versionKey}`);
      const versionAdvanced = Number(versionAfter) > versionBeforeNumber;
      const elapsedMs = Date.now() - warmStartedAt;
      assert.ok(leaveVisible, `booked leave ${leaveRow.id} is not visible in the other worker's team view`);
      assert.ok(versionAdvanced, `company version did not advance: ${versionBefore} -> ${versionAfter}`);
      assert.ok(elapsedMs < 10000, `warm-to-final-read took ${elapsedMs}ms; TTL could have contributed`);

      proc.kill('SIGTERM');
      const stopped = await new Promise(resolve => proc.once('close', (code, signal) => resolve({code, signal})));
      assert.equal(stopped.code, 0, output);

      process.stdout.write(JSON.stringify({
        case: 'shared',
        workers: 2,
        cacheKeyWarmed: hasWarmedEntry,
        versionBefore: versionBeforeNumber,
        versionAfter: Number(versionAfter),
        versionAdvanced,
        leaveVisibleAcrossWorkers: leaveVisible,
        elapsedMs,
        signalExit: stopped.code,
      }) + '\n');
    } finally {
      clearTimeout(watchdog);
      try { if (redis.isOpen) { await redis.del(`teamview:version:${seeded.companyId}`); } } catch { /* best-effort owned cleanup */ }
      try { if (redis.isOpen) { await redis.quit(); } } catch { /* best-effort */ }
      await terminateTree(proc, {graceMs: 100});
    }
  });
}

async function main() {
  const [mode] = process.argv.slice(2);
  if (mode === '--prerequisite') { await prerequisite('redis'); return; }
  if (mode === '--case' && process.argv[3] === 'shared') { await runShared(); return; }
  throw new Error('Usage: cache_case.js --prerequisite redis | --case shared');
}
