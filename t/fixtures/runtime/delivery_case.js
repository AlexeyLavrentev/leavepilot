#!/usr/bin/env node
'use strict';

// MUT-03 subprocess fault-injection suite: real HTTP mutations against a real
// application process, with a delivery-side fault injected AFTER the commit,
// across every mutation family (create, approve, reject, cancel, revoke,
// bulk approve, bulk reject).
//
// Three fault contours plus a control pass:
//   email        - the mail transport fails for lib/email.js (send_emails on,
//                  nodemailer intercepted for that one consumer), so every
//                  'email' outbox record exhausts its bounded retries.
//   edition_event- the registered edition_event executor rejects, so every
//                  'edition_event' outbox record exhausts its bounded retries.
//   cache        - the team-view cache client is routed through a blocked
//                  RESP2 proxy (the Phase 3 store-outage mechanism), so every
//                  post-commit invalidation bump fails red while the outbox
//                  itself keeps delivering.
//   control      - no fault: every record delivers (non-vacuous-green proof).
//
// In every contour and for every family the proof is the same: the HTTP
// mutation returns today's exact success flash, a follow-up read shows the
// committed state (the user is never invited to repeat the mutation), and the
// failure is observable only in operator channels (red events in the child's
// captured output, failed outbox records) - MUT-02's separation, in a real
// subprocess.
//
// Discipline (Phase 2/3): the suite never provisions its own services; the
// verifier fails red with the exact setup command. Every wait is bounded; a
// hang is a failure, never a slow pass. First failure retained - no retries,
// no reclassification, no retry-to-green.

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
const MYSQL_PREFIX = 'leavepilot_delivery_test_';
const HOST = '127.0.0.1';
const PORTS = {mysql: 13306, redis: 16379};
const PASSWORD = 'delivery-case-only-password';
const LEAVER_FULL_NAME = 'Leaver User';

// Test-only calibration of the delivery worker's tick, injected through the
// preload (NOT a production knob - the shipped worker stays at 30s, D-05):
// 200ms makes exhaustion observable inside the suite's bounded deadline
// without touching the retry/backoff envelope being proven (1s..30s).
const SHRUNKEN_TICK_MS = 200;

const EMAIL_OUTAGE_ERROR = new Error('synthetic smtp outage');
const EDITION_OUTAGE_ERROR = new Error('synthetic edition event failure');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const childBaseEnv = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key])
  .map(key => [key, process.env[key]]));

// Structured log lines carry the event name twice (msg + event fields), so
// events are counted per LINE, never per substring occurrence.
const countEventLines = (text, eventName) =>
  text.split('\n').filter(line => line.includes(eventName)).length;

// Every wait in this fixture carries an explicit deadline: a hang is a
// failure, never a slow pass.
async function until(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) { return; }
    await wait(50);
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

// ===== Child preload ========================================================
//
// Runs via `node --require <this file> bin/wwww` before the application
// loads. Test-only Module._load wraps, each keyed on ONE consumer (the
// cache_case.js pattern); none of this code is reachable in production.
if (process.env.TEST_DELIVERY_CASE_PRELOAD === '1') {
  const contour = process.env.TEST_DELIVERY_CONTOUR || 'control';
  const Module = require('node:module');
  const originalLoad = Module._load;

  Module._load = function(request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments);

    // Every contour (control included): shrink the delivery worker's tick so
    // delivery and exhaustion are observable inside the suite deadline. The
    // worker itself stays always-on per D-05 - only its interval changes, and
    // only for this child process.
    if (request === '../scheduler/delivery_outbox_worker'
        && parent && /lib[\\/]edition[\\/]community\.js$/.test(parent.filename)) {
      return Object.assign({}, loaded, {
        startDeliveryOutboxWorker: options => loaded.startDeliveryOutboxWorker(
          Object.assign({}, options, {tickMs: SHRUNKEN_TICK_MS})
        ),
      });
    }

    // Email contour: `email_transporter` is not env-overridable (nconf layers
    // config/app.json with an explicit env allowlist only), so the transport
    // is intercepted at module resolution - for the lib/email.js consumer
    // only - and send_emails/email_transporter are switched on through the
    // config seam below.
    if (contour === 'email' && request === 'nodemailer'
        && parent && /lib[\\/]email\.js$/.test(parent.filename)) {
      return {
        createTransport: () => ({
          sendMail: (mail, callback) => (typeof callback === 'function'
            ? callback(EMAIL_OUTAGE_ERROR)
            : Promise.reject(EMAIL_OUTAGE_ERROR)),
        }),
      };
    }

    // Edition contour: stub the edition_event executor at registration time
    // (before edition initialize runs) so its delivery promise rejects - the
    // worker's bounded retry policy then applies to edition events exactly
    // as it does to email (D-03/D-10).
    if (contour === 'edition_event' && request === './registry'
        && parent && /lib[\\/]edition[\\/]index\.js$/.test(parent.filename)) {
      const originalRegister = loaded.prototype.registerDeliveryExecutor;
      loaded.prototype.registerDeliveryExecutor = function(executor) {
        if (executor && executor.deliveryType === 'edition_event') {
          return originalRegister.call(this, {
            deliveryType: 'edition_event',
            deliver: () => Promise.reject(EDITION_OUTAGE_ERROR),
          });
        }
        return originalRegister.call(this, executor);
      };
      return loaded;
    }

    // Cache contour: route ONLY the team-view cache client through the
    // outage proxy in front of the real fixture (the Phase 3 store-outage
    // mechanism, keyed on team_view_cache.js). Sessions keep their direct
    // fixture connection so the contour stays on the mutation path.
    if (contour === 'cache' && request === 'redis'
        && parent && /team_view_cache\.js$/.test(parent.filename)) {
      const proxyPort = Number(process.env.TEST_DELIVERY_OUTAGE_PROXY_PORT);
      return {
        createClient: options => loaded.createClient(Object.assign({}, options, {
          socket: Object.assign({}, options && options.socket, {host: HOST, port: proxyPort}),
        })),
      };
    }

    return loaded;
  };

  if (contour === 'email') {
    const config = require('../../../lib/config');
    config.set('send_emails', true);
    config.set('email_transporter', {name: 'synthetic-outage-smtp', version: '1'});
  }

  if (contour === 'cache') {
    const config = require('../../../lib/config');
    config.set('sessionStore', {
      useRedis: true,
      redisConnectionConfiguration: {host: HOST, port: PORTS.redis},
    });
  }
}

// ===== Parent-side helpers ==================================================

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

async function prerequisite(selection = 'redis') {
  exactInputs();
  assert.ok(Object.hasOwn(PORTS, selection), 'Unknown prerequisite selection');
  await pingResp(PORTS[selection]);
  process.stdout.write(`${selection} ready\n`);
}

// RESP2 fault proxy (the Phase 2/3 outage mechanism): while blocked it
// destroys every existing connection and every new downstream connection,
// which the cache client's fail-fast socket options turn into an immediate
// bypass instead of a hang.
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
        server.listen(0, HOST, resolve);
      });
      return server.address().port;
    },
    async close() {
      for (const socket of sockets) { socket.destroy(); }
      await new Promise(resolve => server.close(resolve));
    },
  };
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
    ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(3000),
  });
  return {status: result.status, body: await result.text(),
    cookie: result.headers.getSetCookie().find(item => item.startsWith('connect.sid='))?.split(';')[0],
    location: result.headers.get('location')};
}

function sqlConnection(database, user, password) {
  return new Sequelize(database, user, password, {
    dialect: 'mysql', host: HOST, port: PORTS.mysql, logging: false,
    dialectOptions: {connectTimeout: 1500}, pool: {max: 1, min: 0, acquire: 2000},
  });
}

async function withDatabase(operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-delivery-case-'));
  const name = `${MYSQL_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
  assert.match(name, /^leavepilot_delivery_test_[a-f0-9]{12}$/);
  const storage = path.join(directory, 'app.sqlite');
  let admin;
  try {
    admin = sqlConnection('leavepilot_runtime_test', 'root', 'runtime_root_test_only');
    await admin.query(`CREATE DATABASE \`${name}\``);
    await admin.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO 'leavepilot_runtime_test'@'%'`);
    return await operation(name, storage, admin);
  } finally {
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS \`${name}\``); }
      finally { await admin.close(); }
    }
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

// '#DB#' is a plain placeholder (not a template literal) so the SQL strings
// stay readable without tripping no-template-curly-in-string.
async function sqlRows(admin, database, statement) {
  const [rows] = await admin.query(statement.replaceAll('#DB#', `\`${database}\``));
  return rows;
}

async function sqlOne(admin, database, statement) {
  const [row] = await sqlRows(admin, database, statement);
  return row;
}

function baseEnv(database, port, storage, contour) {
  return {
    NODE_ENV: 'test', TZ: 'UTC', DB_DIALECT: 'mysql', DB_NAME: database,
    DB_HOST: HOST, DB_PORT: String(PORTS.mysql), DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD, DB_STORAGE: storage, DB_LOGGING: 'false',
    PORT: String(port), HOST: HOST, SESSION_SECRET: 'delivery-case-only-session-secret',
    CRYPTO_SECRET: 'delivery-case-only-crypto-secret', SILENCE_HTTP_LOGS: 'true',
    DISABLE_AUTH_RATE_LIMIT: 'true', DISABLE_NOTIFICATIONS_POLLING: 'true',
    SILENCE_PRETEND_EMAILS: 'true', LEAVEPILOT_EDITION: 'community',
    // Keep the captured output at error/warn: the shrunk 200ms tick would
    // otherwise flood debug sweep lines and push the red events this suite
    // asserts on out of the retained window.
    LOG_LEVEL: 'warn',
    TEST_DELIVERY_CASE_PRELOAD: '1',
    TEST_DELIVERY_CONTOUR: contour,
  };
}

async function seed(env, viewerEmail, leaverEmail) {
  const result = await child(['-e', `
    const db = require('./lib/model/db');
    (async () => {
      await db.connect();
      const company = await db.Company.create({name:'DeliveryCase',country:'GB',start_of_new_year:1});
      const department = await db.Department.create({name:'Test',companyId:company.id});
      const leaveType = await db.LeaveType.create({name:'Holiday',color:'#008000',companyId:company.id});
      const build = (name,email,admin) => ({name,lastname:'User',email,
        password:db.User.hashify_password(${JSON.stringify(PASSWORD)}),
        companyId:company.id,DepartmentId:department.id,admin,activated:true});
      const viewer = await db.User.create(build('Viewer',${JSON.stringify(viewerEmail)},true));
      const leaver = await db.User.create(build('Leaver',${JSON.stringify(leaverEmail)},false));
      await department.update({bossId:viewer.id});
      await db.sequelize.close();
      console.log(JSON.stringify({companyId:company.id,leaveTypeId:leaveType.id,
        departmentId:department.id,viewerId:viewer.id,leaverId:leaver.id}));
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
    body: new URLSearchParams({_csrf: csrf, email, password: PASSWORD}),
  });
  assert.equal(result.status, 302);
  assert.match(result.cookie || '', /^connect\.sid=/);
  return {cookie: result.cookie};
}

function extractCsrf(body) {
  return body.match(/name=["']_csrf["'][^>]*value=["']([^"']+)/i)?.[1];
}

async function postForm(port, cookie, route, fields) {
  const page = await request(port, '/calendar/', cookie);
  const csrf = extractCsrf(page.body);
  assert.ok(csrf, 'no CSRF token on /calendar/');
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) { value.forEach(item => body.append(key, String(item))); }
    else { body.set(key, String(value)); }
  }
  body.set('_csrf', csrf);
  const result = await request(port, route, cookie, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf},
    body,
  });
  return result;
}

function alertsFrom(body) {
  return (body.match(/<div class="alert[^>]*>[^<]*/g) || [])
    .map(entry => entry.replace(/<div class="alert[^>]*>/, '').trim());
}

// Follow the mutation's redirect chain (each hop preserves the session; the
// flash renders on the terminal page) and read the outcome off that page:
// today's exact success flash, no error flash, and (D-06) nothing that could
// read as delivery state or an invitation to repeat the mutation.
async function followOutcome(port, cookie, location, context) {
  let target = location && location.startsWith('/')
    ? location
    : new URL(location || '/requests/', `http://${HOST}:${port}/`).pathname;
  let page = null;
  for (let hop = 0; hop < 5; hop++) {
    page = await request(port, target, cookie);
    if (page.status === 200) { break; }
    assert.equal(page.status, 302,
      `${context}: outcome page ${target} returned ${page.status}`);
    assert.ok(page.location, `${context}: outcome page ${target} redirected without a location`);
    target = page.location.startsWith('/')
      ? page.location
      : new URL(page.location, `http://${HOST}:${port}${target}`).pathname;
    page = null;
  }
  assert.ok(page && page.status === 200,
    `${context}: the redirect chain from ${location} never produced a page`);
  const alerts = alertsFrom(page.body);
  assert.ok(!page.body.includes('alert-danger'), `${context} flashed an error: ${JSON.stringify(alerts)}`);
  for (const text of alerts) {
    assert.ok(!/retr|deliver|smtp|resend|try again/i.test(text),
      `${context} surfaced delivery state in a flash: ${text}`);
  }
  return alerts;
}

// The company calendar anchors on Europe/London (country GB); pick clean,
// collision-free future weekdays so no family ever books into the past or
// trips the overlap validation. Calendar dates are timezone-free ymd strings.
function futureWeekdays(count) {
  const londonToday = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/London'}).format(new Date());
  const [year, month, day] = londonToday.split('-').map(Number);
  const dates = [];
  for (let ms = Date.UTC(year, month - 1, day) + 86400000; dates.length < count; ms += 86400000) {
    const weekday = new Date(ms).getUTCDay();
    if (weekday >= 1 && weekday <= 5) { dates.push(new Date(ms).toISOString().slice(0, 10)); }
  }
  return dates;
}

// Own-leave status chip from the employee's /requests/ page (the row that
// carries data-leave-id="<id>"), or null when the leave left the active list.
function ownRowStatus(body, leaveId) {
  const row = body.split(/<tr[^>]*>/).find(chunk => chunk.includes(`data-leave-id="${leaveId}"`));
  if (!row) { return null; }
  const chip = row.match(/request-status--(pending|approved|rejected)/);
  return chip ? chip[1] : 'none';
}

function ownRowHasPendedRevoke(body, leaveId) {
  const row = body.split(/<tr[^>]*>/).find(chunk => chunk.includes(`data-leave-id="${leaveId}"`));
  return !!row && row.includes('pended revoke');
}

async function bootApp(env) {
  const port = Number(env.PORT);
  const proc = spawnInGroup(process.execPath, ['--require', __filename, 'bin/wwww'], {
    cwd: root, env: {...childBaseEnv, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on('data', chunk => {
      if (output.length < 1000000) { output += chunk.toString(); }
    });
  }
  const watchdog = setTimeout(() => { terminateTree(proc, {graceMs: 100}).catch(() => {}); }, 240000);
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && proc.exitCode === null) {
      try {
        const result = await request(port, '/login/');
        if (result.status === 200) {
          return {port, proc, output: () => output, watchdog};
        }
      } catch { /* The listener is deliberately closed until dependencies are ready. */ }
      await wait(100);
    }
    throw new Error(`runtime did not become ready: ${output}`);
  } catch (error) {
    clearTimeout(watchdog);
    await terminateTree(proc, {graceMs: 100});
    throw error;
  }
}

async function stopApp(app) {
  clearTimeout(app.watchdog);
  app.proc.kill('SIGTERM');
  const stopped = await new Promise(resolve => app.proc.once('close', code => resolve(code)));
  assert.equal(stopped, 0, app.output());
  await terminateTree(app.proc, {graceMs: 100});
  return stopped;
}

async function teardownApp(app) {
  clearTimeout(app.watchdog);
  await terminateTree(app.proc, {graceMs: 100});
}

async function outboxStatusCounts(admin, database, deliveryType) {
  const rows = await sqlRows(admin, database,
    `SELECT status, COUNT(*) AS c FROM #DB#.\`DeliveryOutboxes\` WHERE delivery_type = '${deliveryType}' GROUP BY status`);
  const counts = {};
  for (const row of rows) { counts[row.status] = Number(row.c); }
  return counts;
}

const totalOf = counts => (counts.pending || 0) + (counts.failed || 0) + (counts.delivered || 0);

// ===== The seven-family mutation matrix =====================================
//
// Every contour runs the SAME matrix; only the injected fault differs. The
// exact success flashes come from public/locales/en/translation.json and are
// asserted byte-identically (the MUT-01 compatibility line). After the
// bounded drain the committed-state assertions are RE-RUN (the user was not
// invited to repeat the mutation, and exhaustion changed nothing user-facing).

async function runMatrix(ctx) {
  const {port, admin, database, seeded, viewer, leaver} = ctx;
  const dates = futureWeekdays(9);
  const committedChecks = [];

  const latestLeaveId = async () => {
    const row = await sqlOne(admin, database,
      `SELECT id FROM #DB#.\`Leaves\` WHERE userId = ${seeded.leaverId} ORDER BY id DESC LIMIT 1`);
    assert.ok(row && row.id, 'no leave row after booking');
    return row.id;
  };

  const employeePage = async () => (await request(port, '/requests/', leaver.cookie)).body;
  const viewerPage = async () => (await request(port, '/requests/', viewer.cookie)).body;

  const registerCommittedCheck = (family, check) => {
    committedChecks.push({family, check});
  };

  const assertLeaveStatus = async (leaveId, expectedStatus, family) => {
    const row = await sqlOne(admin, database, `SELECT status FROM #DB#.\`Leaves\` WHERE id = ${leaveId}`);
    assert.ok(row, `${family}: leave ${leaveId} row missing from the database`);
    assert.equal(row.status, expectedStatus,
      `${family}: leave ${leaveId} status ${row.status}, expected ${expectedStatus}`);
  };

  const book = async (date, family) => {
    const booking = await postForm(port, leaver.cookie, '/calendar/bookleave/', {
      leave_type: seeded.leaveTypeId,
      from_date: date,
      from_date_part: '1',
      to_date: date,
      to_date_part: '1',
      reason: 'delivery case proof',
    });
    assert.equal(booking.status, 302, booking.body.slice(0, 300));
    const alerts = await followOutcome(port, leaver.cookie, booking.location, `${family} booking ${date}`);
    assert.ok(alerts.some(text => text === 'New leave request was added'),
      `${family} booking ${date} did not flash the exact create success: ${JSON.stringify(alerts)}`);
    ctx.counters.leaveMutations += 1;
    return latestLeaveId();
  };

  const decide = async (cookie, action, leaveId, family) => {
    const result = await postForm(port, cookie, `/requests/${action}/`, {request: String(leaveId)});
    assert.equal(result.status, 302, result.body.slice(0, 300));
    const alerts = await followOutcome(port, cookie, result.location, `${family} ${action} ${leaveId}`);
    const expected = `Request from ${LEAVER_FULL_NAME} was processed`;
    assert.ok(alerts.some(text => text === expected),
      `${family} ${action} did not flash the exact decision success: ${JSON.stringify(alerts)}`);
    ctx.counters.leaveMutations += 1;
  };

  const cancel = async leaveId => {
    const result = await postForm(port, leaver.cookie, '/requests/cancel/', {request: String(leaveId)});
    assert.equal(result.status, 302, result.body.slice(0, 300));
    const alerts = await followOutcome(port, leaver.cookie, result.location, `cancel ${leaveId}`);
    assert.ok(alerts.some(text => text === 'The leave request was canceled'),
      `cancel ${leaveId} did not flash the exact cancel success: ${JSON.stringify(alerts)}`);
    ctx.counters.leaveMutations += 1;
  };

  const revoke = async leaveId => {
    const result = await postForm(port, leaver.cookie, '/requests/revoke/', {request: String(leaveId)});
    assert.equal(result.status, 302, result.body.slice(0, 300));
    const alerts = await followOutcome(port, leaver.cookie, result.location, `revoke ${leaveId}`);
    const expected = 'You have requested leave to be revoked. Your supervisor needs to approve it.';
    assert.ok(alerts.some(text => text === expected),
      `revoke ${leaveId} did not flash the exact revoke success: ${JSON.stringify(alerts)}`);
    ctx.counters.leaveMutations += 1;
  };

  const bulk = async (action, leaveIds) => {
    const result = await postForm(port, viewer.cookie, `/requests/bulk/${action}/`, {request: leaveIds});
    assert.equal(result.status, 302, result.body.slice(0, 300));
    const alerts = await followOutcome(port, viewer.cookie, result.location, `bulk ${action}`);
    // The bulk flash carries the translated action label ("Approve"/
    // "Reject"), not the route segment.
    const actionLabel = action === 'approve' ? 'Approve' : 'Reject';
    const expected = `${leaveIds.length} request(s) were processed (${actionLabel}).`;
    assert.ok(alerts.some(text => text === expected),
      `bulk ${action} did not flash the exact bulk success: ${JSON.stringify(alerts)}`);
    ctx.counters.leaveMutations += leaveIds.length;
  };

  const readAndCheck = async () => {
    for (const {family, check} of committedChecks) {
      await check({employeeHtml: await employeePage(), viewerHtml: await viewerPage(), family});
    }
  };

  // Family 1 - create: the employee books leave; the committed state is the
  // pending row on the employee's own page and the new entry in the
  // supervisor's approval queue.
  {
    const leaveId = await book(dates[0], 'create');
    await assertLeaveStatus(leaveId, 1, 'create');
    registerCommittedCheck('create', ({employeeHtml, viewerHtml}) => {
      assert.equal(ownRowStatus(employeeHtml, leaveId), 'pending',
        'create: the booked leave is not pending on the employee page');
      assert.ok(viewerHtml.includes(`data-leave-id="${leaveId}"`),
        'create: the booked leave never reached the approval queue');
    });
  }

  // Family 2 - approve.
  {
    const leaveId = await book(dates[1], 'approve-setup');
    await decide(viewer.cookie, 'approve', leaveId, 'approve');
    await assertLeaveStatus(leaveId, 2, 'approve');
    registerCommittedCheck('approve', ({employeeHtml, viewerHtml}) => {
      assert.equal(ownRowStatus(employeeHtml, leaveId), 'approved',
        'approve: the leave is not approved on the employee page');
      assert.ok(!viewerHtml.includes(`data-leave-id="${leaveId}"`),
        'approve: the approved leave is still in the approval queue');
    });
  }

  // Family 3 - reject: the leave leaves every active list.
  {
    const leaveId = await book(dates[2], 'reject-setup');
    await decide(viewer.cookie, 'reject', leaveId, 'reject');
    await assertLeaveStatus(leaveId, 3, 'reject');
    registerCommittedCheck('reject', ({employeeHtml, viewerHtml}) => {
      assert.equal(ownRowStatus(employeeHtml, leaveId), null,
        'reject: the rejected leave is still on the employee page');
      assert.ok(!viewerHtml.includes(`data-leave-id="${leaveId}"`),
        'reject: the rejected leave is still in the approval queue');
    });
  }

  // Family 4 - cancel (by the employee, on their own pending leave).
  {
    const leaveId = await book(dates[3], 'cancel-setup');
    await cancel(leaveId);
    await assertLeaveStatus(leaveId, 5, 'cancel');
    registerCommittedCheck('cancel', ({employeeHtml, viewerHtml}) => {
      assert.equal(ownRowStatus(employeeHtml, leaveId), null,
        'cancel: the canceled leave is still on the employee page');
      assert.ok(!viewerHtml.includes(`data-leave-id="${leaveId}"`),
        'cancel: the canceled leave is still in the approval queue');
    });
  }

  // Family 5 - revoke of an approved leave (needs supervisor approval):
  // the committed state is pended_revoke, visible on both pages.
  {
    const leaveId = await book(dates[4], 'revoke-setup');
    await decide(viewer.cookie, 'approve', leaveId, 'revoke-setup');
    await revoke(leaveId);
    await assertLeaveStatus(leaveId, 4, 'revoke');
    registerCommittedCheck('revoke', ({employeeHtml, viewerHtml}) => {
      assert.ok(ownRowHasPendedRevoke(employeeHtml, leaveId),
        'revoke: the pended-revoke state is not visible on the employee page');
      assert.ok(viewerHtml.includes(`data-leave-id="${leaveId}"`),
        'revoke: the revocation request never reached the approval queue');
    });
  }

  // Family 6 - bulk approve.
  {
    const first = await book(dates[5], 'bulk-approve-setup');
    const second = await book(dates[6], 'bulk-approve-setup');
    await bulk('approve', [first, second]);
    await assertLeaveStatus(first, 2, 'bulk approve');
    await assertLeaveStatus(second, 2, 'bulk approve');
    registerCommittedCheck('bulk approve', ({employeeHtml}) => {
      assert.equal(ownRowStatus(employeeHtml, first), 'approved', 'bulk approve: first item not approved');
      assert.equal(ownRowStatus(employeeHtml, second), 'approved', 'bulk approve: second item not approved');
    });
  }

  // Family 7 - bulk reject.
  {
    const first = await book(dates[7], 'bulk-reject-setup');
    const second = await book(dates[8], 'bulk-reject-setup');
    await bulk('reject', [first, second]);
    await assertLeaveStatus(first, 3, 'bulk reject');
    await assertLeaveStatus(second, 3, 'bulk reject');
    registerCommittedCheck('bulk reject', ({employeeHtml}) => {
      assert.equal(ownRowStatus(employeeHtml, first), null, 'bulk reject: first item still active');
      assert.equal(ownRowStatus(employeeHtml, second), null, 'bulk reject: second item still active');
    });
  }

  // Every family just committed with its exact success flash: assert the
  // committed state through real follow-up reads before any drain waiting.
  await readAndCheck();

  return {
    families: committedChecks.map(entry => entry.family),
    recheck: readAndCheck,
  };
}

// ===== Contours =============================================================

async function runContour(contourId) {
  await prerequisite('redis');
  assert.ok(['email', 'edition_event', 'cache', 'control'].includes(contourId),
    `Unknown contour: ${contourId}`);

  const proxy = contourId === 'cache' ? startProxy(HOST, PORTS.redis) : null;
  const proxyPort = proxy ? await proxy.listen() : 0;
  const redis = contourId === 'cache'
    ? createClient({socket: {host: HOST, port: PORTS.redis}, RESP: 2})
    : null;
  if (redis) { redis.on('error', () => {}); }

  try {
    return await withDatabase(async (database, storage, admin) => {
      const port = await freePort();
      const env = baseEnv(database, port, storage, contourId);
      if (contourId === 'cache') { env.TEST_DELIVERY_OUTAGE_PROXY_PORT = String(proxyPort); }

      const migration = await child(['bin/db_update.js'], env, 30000);
      assert.equal(migration.code, 0, migration.output);

      const runTag = crypto.randomBytes(4).toString('hex');
      const viewerEmail = `dlv-viewer-${runTag}@example.test`;
      const leaverEmail = `dlv-leaver-${runTag}@example.test`;
      const seeded = await seed(env, viewerEmail, leaverEmail);

      const app = await bootApp(env);
      let signalExit = null;
      try {
        const viewer = await login(app.port, viewerEmail);
        const leaver = await login(app.port, leaverEmail);
        // Consume any login flash so later outcome pages only carry the
        // mutation flashes under assertion.
        await request(app.port, '/calendar/', viewer.cookie);
        await request(app.port, '/calendar/', leaver.cookie);

        const ctx = {
          port: app.port, admin, database, seeded, viewer, leaver,
          counters: {leaveMutations: 0},
        };

        // The cache contour blocks the store for the WHOLE mutation matrix:
        // every family's post-commit invalidation must fail red while every
        // mutation still commits and every outbox record still delivers.
        if (proxy) { proxy.setBlocked(true); }
        if (redis) { await redis.connect(); }

        const matrix = await runMatrix(ctx);
        const leaveMutations = ctx.counters.leaveMutations;
        assert.ok(leaveMutations >= 18, `unexpectedly few leave mutations: ${leaveMutations}`);

        // Every mutation enqueues exactly one record per delivery type in the
        // same transaction (D-01/D-09) - the count is the atomicity receipt.
        const emailCounts = await outboxStatusCounts(admin, database, 'email');
        const editionCounts = await outboxStatusCounts(admin, database, 'edition_event');
        assert.equal(totalOf(emailCounts), leaveMutations,
          `email outbox records (${JSON.stringify(emailCounts)}) do not match the ${leaveMutations} mutations`);
        assert.equal(totalOf(editionCounts), leaveMutations,
          `edition_event outbox records (${JSON.stringify(editionCounts)}) do not match the ${leaveMutations} mutations`);

        let verdictExtra = {};

        if (contourId === 'email' || contourId === 'edition_event') {
          const faultedType = contourId === 'email' ? 'email' : 'edition_event';
          const otherType = contourId === 'email' ? 'edition_event' : 'email';
          const outageMarker = contourId === 'email'
            ? EMAIL_OUTAGE_ERROR.message : EDITION_OUTAGE_ERROR.message;

          // Bounded drain: the faulted records walk the real production
          // backoff (1s..30s, five attempts) to terminal failed - the
          // shrunken tick only makes the sweeps frequent, never the backoff.
          await until(async () => {
            const counts = await outboxStatusCounts(admin, database, faultedType);
            return totalOf(counts) > 0 && !(counts.pending > 0)
              && counts.failed === totalOf(counts);
          }, 75000, `all ${faultedType} outbox records to exhaust`);

          const faultedCounts = await outboxStatusCounts(admin, database, faultedType);
          const faultedTotal = totalOf(faultedCounts);
          const exhaustedEvents = countEventLines(app.output(), 'delivery_exhausted');
          const attemptEvents = countEventLines(app.output(), 'delivery_attempt_failed');

          assert.equal(faultedCounts.failed, faultedTotal,
            `not every ${faultedType} record reached terminal failed: ${JSON.stringify(faultedCounts)}`);
          assert.equal(exhaustedEvents, faultedTotal,
            `delivery_exhausted fired ${exhaustedEvents} times for ${faultedTotal} records`);
          assert.ok(attemptEvents >= faultedTotal,
            `delivery_attempt_failed missing from the captured output (${attemptEvents} events)`);
          assert.ok(app.output().includes(outageMarker),
            `the injected ${faultedType} failure never reached the red events`);

          // The non-faulted type of the SAME mutations delivers (MUT-03
          // adjacency: one failing delivery type never blocks the other).
          await until(async () => {
            const counts = await outboxStatusCounts(admin, database, otherType);
            return totalOf(counts) > 0 && !(counts.pending > 0) && !counts.failed;
          }, 30000, `all ${otherType} outbox records to deliver`);
          const otherCounts = await outboxStatusCounts(admin, database, otherType);
          assert.equal(otherCounts.delivered, leaveMutations,
            `the non-faulted ${otherType} records did not all deliver: ${JSON.stringify(otherCounts)}`);

          verdictExtra = {
            faulted_type: faultedType,
            faulted_records: faultedTotal,
            faulted_failed: faultedCounts.failed,
            exhausted_events: exhaustedEvents,
            other_type_delivered: otherCounts.delivered,
          };
        } else {
          // cache and control contours: delivery is healthy - every record
          // of both types delivers, nothing exhausts, no red delivery event.
          for (const deliveryType of ['email', 'edition_event']) {
            await until(async () => {
              const counts = await outboxStatusCounts(admin, database, deliveryType);
              return totalOf(counts) > 0 && !(counts.pending > 0) && !counts.failed;
            }, 30000, `all ${deliveryType} outbox records to deliver`);
            const counts = await outboxStatusCounts(admin, database, deliveryType);
            assert.equal(counts.delivered, leaveMutations,
              `${deliveryType} records did not all deliver: ${JSON.stringify(counts)}`);
          }
          assert.ok(!app.output().includes('delivery_exhausted'),
            'a delivery exhausted in a contour with no injected delivery fault');
          assert.ok(!app.output().includes('delivery_attempt_failed'),
            'a delivery attempt failed in a contour with no injected delivery fault');

          if (contourId === 'cache') {
            // The Phase 3 red event is the honest D-09 record of the failed
            // invalidation: one per leave mutation, all inside the outage
            // window, with zero hook changes (the hooks are untouched code).
            await until(() => countEventLines(app.output(), 'team_view_invalidation_failed') >= leaveMutations,
              15000, `at least ${leaveMutations} team_view_invalidation_failed events`);
            const invalidationEvents = countEventLines(app.output(), 'team_view_invalidation_failed');
            verdictExtra = {invalidation_events: invalidationEvents};
          }
        }

        // The decisive MUT-03 re-check: after exhaustion (or the healthy
        // drain), the committed state is unchanged and no user surface ever
        // invited a repeat - re-run every family's committed-state read.
        await matrix.recheck();

        if (proxy) { proxy.setBlocked(false); }
        signalExit = await stopApp(app);

        return Object.assign({
          contour: contourId,
          workers: 1,
          mutations: leaveMutations,
          families: matrix.families,
          user_outcomes_rechecked: true,
          signal_exit: signalExit,
        }, verdictExtra);
      } finally {
        if (proxy) { proxy.setBlocked(false); }
        if (redis && redis.isOpen) {
          try {
            const keys = await redis.keys('teamview:*');
            if (keys.length) { await redis.del(keys); }
          } catch { /* best-effort owned cleanup */ }
          try { await redis.quit(); } catch { /* best-effort */ }
        }
        if (signalExit === null) { await teardownApp(app); }
      }
    });
  } finally {
    if (proxy) { await proxy.close(); }
  }
}

// ===== Suite mode (delivery-outcome verify stage) ===========================
//
// Every contour in one bounded invocation, in order: email, edition_event,
// cache, control. Each contour keeps its own fresh database, child process,
// outage proxy and teardown discipline; a contour that fails aborts the
// suite through its assertions, so the aggregate verdict line only prints
// when every contour really completed - and the boolean is still derived
// from the verdict fields rather than assumed from the absence of a throw.

const SUITE_CONTOURS = [
  {id: 'email', run: () => runContour('email')},
  {id: 'edition_event', run: () => runContour('edition_event')},
  {id: 'cache', run: () => runContour('cache')},
  {id: 'control', run: () => runContour('control')},
];

function contourPassed(id, verdict) {
  const shared = verdict.user_outcomes_rechecked === true
    && verdict.signal_exit === 0
    && verdict.mutations >= 18
    && verdict.families.length === 7;
  if (id === 'email' || id === 'edition_event') {
    return shared && verdict.faulted_records > 0
      && verdict.faulted_failed === verdict.faulted_records
      && verdict.exhausted_events === verdict.faulted_records
      && verdict.other_type_delivered === verdict.mutations;
  }
  if (id === 'cache') {
    return shared && verdict.invalidation_events >= verdict.mutations;
  }
  return shared;
}

async function runSuite() {
  await prerequisite('redis');
  const startedAt = Date.now();
  const results = [];
  for (const contour of SUITE_CONTOURS) {
    const contourStartedAt = Date.now();
    const verdict = await contour.run();
    const passed = contourPassed(contour.id, verdict);
    assert.ok(passed, `contour ${contour.id} completed but its verdict reports a failure`);
    results.push({contour: contour.id, passed, durationMs: Date.now() - contourStartedAt});
  }
  const allPassed = results.length === SUITE_CONTOURS.length
    && results.every(entry => entry.passed);
  return {
    case: 'suite',
    contours: SUITE_CONTOURS.map(contour => contour.id),
    all_contours_passed: allPassed,
    results,
    total_duration_ms: Date.now() - startedAt,
  };
}

async function main() {
  const [mode] = process.argv.slice(2);
  const printVerdict = verdict => process.stdout.write(JSON.stringify(verdict) + '\n');
  if (mode === '--prerequisite') { await prerequisite('redis'); return; }
  if (mode === '--suite') { printVerdict(await runSuite()); return; }
  for (const contour of SUITE_CONTOURS) {
    if (mode === '--case' && process.argv[3] === contour.id) {
      printVerdict(await contour.run());
      return;
    }
  }
  throw new Error('Usage: delivery_case.js --prerequisite redis | --suite | --case email | --case edition_event | --case cache | --case control');
}

// The dispatcher lives at the bottom of the file so every declaration it
// reaches (SUITE_CONTOURS, the contour functions) is already initialized.
if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
