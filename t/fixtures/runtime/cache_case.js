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
      const matrixType = await db.LeaveType.create({name:'Matrixalt',color:'leave_type_color_5',companyId:company.id});
      const build = (name,email,admin) => ({name,lastname:'User',email,
        password:db.User.hashify_password('cache-case-only-password'),
        companyId:company.id,DepartmentId:department.id,admin,activated:true});
      const viewer = await db.User.create(build('Viewer',${JSON.stringify(viewerEmail)},true));
      const leaver = await db.User.create(build('Leaver',${JSON.stringify(leaverEmail)},false));
      await department.update({bossId:viewer.id});
      await db.sequelize.close();
      console.log(JSON.stringify({companyId:company.id,leaveTypeId:leaveType.id,
        matrixLeaveTypeId:matrixType.id,departmentId:department.id,
        viewerId:viewer.id,leaverId:leaver.id}));
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

      // The booking redirect never distinguishes success from a flashed
      // failure, so read the outcome off the leaver's next page: the leave
      // must have been created before the cross-worker read is meaningful.
      const aftermath = await request(port, '/calendar/', leaver.cookie);
      const alerts = (aftermath.body.match(/<div class="alert[^>]*>[^<]*/g) || [])
        .map(entry => entry.replace(/<div class="alert[^>]*>/, '').trim());
      assert.ok(alerts.some(text => /added/i.test(text)),
        `leave booking did not succeed (alerts: ${JSON.stringify(alerts)})\n${output}`);

      const [[leaveRow]] = await admin.query(`SELECT id FROM \`${database}\`.\`Leaves\` ORDER BY id DESC LIMIT 1`);
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

// ===== Family matrix (CACHE-03 completeness criterion) =====================
//
// Seventeen HTTP-representative mutation families. Every family runs the same
// cycle against a real two-worker cluster on the shared Redis fixture: warm
// the SAME viewer's team view through BOTH workers with flash-free direct
// GETs (Pitfall 9), mutate through one worker, then read through the worker
// that did NOT handle the mutation and assert that a family-specific HTML
// marker transitioned, that the shared company version advanced, and that
// the whole warm/mutate/read cycle stayed far inside the 30 s TTL (D-04: TTL
// expiry is never load-bearing for any assertion).
//
// Hooks are the ONLY invalidation mechanism: plan 03-01 removed the
// calendar.js bump and this matrix runs against a route layer where plan
// 03-03 removed every remaining hand-placed bump.

const FAMILY_PASSWORD = 'cache-case-only-password';

function familiesEnv(dialect, database, port, storage) {
  return {
    ...baseEnv(dialect, database, port, storage),
    // The work-calendar routes, the preset import and the department
    // work_calendar_id field are feature-gated; enable the flag so those
    // families reach their real HTTP paths.
    FEATURE_WORK_CALENDARS: 'true',
  };
}

async function sqlOne(admin, database, statement) {
  // '#DB#' is a plain placeholder (not a template literal) so the SQL strings
  // below stay readable without tripping no-template-curly-in-string.
  const [[row]] = await admin.query(statement.replaceAll('#DB#', `\`${database}\``));
  return row;
}

const dateInZone = tz => new Intl.DateTimeFormat('en-CA', {timeZone: tz}).format(new Date());

const ymdToUtcMs = ymd => {
  const [year, month, day] = ymd.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
};

const utcMsToYmd = ms => new Date(ms).toISOString().slice(0, 10);

// Pick the month every date-using family anchors on, plus collision-free
// dates inside it: seven leave days, a bank-holiday day, a work-calendar
// holiday day and a free Monday. Only days strictly after the company clock
// are eligible so no family ever books into the past.
function workMonthPlan(companyTodayYmd) {
  const monthKeyOf = ms => utcMsToYmd(ms).slice(0, 7);
  const collect = fromMs => {
    const weekdays = [];
    const mondays = [];
    for (let ms = fromMs; monthKeyOf(ms) === monthKeyOf(fromMs); ms += 86400000) {
      const weekday = new Date(ms).getUTCDay();
      if (weekday >= 1 && weekday <= 5) { weekdays.push(utcMsToYmd(ms)); }
      if (weekday === 1) { mondays.push(utcMsToYmd(ms)); }
    }
    return {weekdays, mondays};
  };

  let fromMs = ymdToUtcMs(companyTodayYmd) + 86400000;
  let month = collect(fromMs);
  let used = new Set(month.weekdays.slice(0, 9));
  let freeMonday = month.mondays.find(date => !used.has(date));
  if (month.weekdays.length < 9 || !freeMonday) {
    // Not enough clean working days left this month: anchor on the next one.
    const [year, monthNumber] = monthKeyOf(fromMs).split('-').map(Number);
    fromMs = Date.UTC(year, monthNumber, 1);
    month = collect(fromMs);
    used = new Set(month.weekdays.slice(0, 9));
    freeMonday = month.mondays.find(date => !used.has(date));
  }
  assert.ok(freeMonday, 'no free Monday in the work month plan');

  return {
    anchor: `${monthKeyOf(fromMs)}-01`,
    leaveDates: month.weekdays.slice(0, 7),
    holidayDate: month.weekdays[7],
    calendarHolidayDate: month.weekdays[8],
    scheduleMonday: freeMonday,
  };
}

// The current-day marker moves with the company timezone: company.get_today()
// renders dayjs.utc().tz(timezone).format('YYYY-MM-DD'). The seeded timezone
// is Europe/London; pick a valid IANA zone whose current date differs.
function pickShiftedTimezone() {
  const londonToday = dateInZone('Europe/London');
  for (const zone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
    if (dateInZone(zone) !== londonToday) { return {zone, londonToday, shiftedToday: dateInZone(zone)}; }
  }
  assert.fail('no timezone with a different company clock found');
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

// The mutator's redirect never distinguishes success from a flashed failure:
// read the actor's next page (which also consumes the flash, so the actor's
// later team-view reads stay flash-free) and assert no error was flashed.
async function consumeFlash(port, cookie, context) {
  const page = await request(port, '/calendar/', cookie);
  const alerts = (page.body.match(/<div class="alert[^>]*>[^<]*/g) || [])
    .map(entry => entry.replace(/<div class="alert[^>]*>/, '').trim());
  assert.ok(!page.body.includes('alert-danger'), `${context} flashed an error: ${JSON.stringify(alerts)}`);
  return alerts;
}

async function bookLeave(port, cookie, leaveTypeId, date) {
  const booking = await postForm(port, cookie, '/calendar/bookleave/', {
    leave_type: leaveTypeId,
    from_date: date,
    from_date_part: '1',
    to_date: date,
    to_date_part: '1',
    reason: 'family matrix',
  });
  assert.equal(booking.status, 302, booking.body.slice(0, 300));
  const alerts = await consumeFlash(port, cookie, `booking ${date}`);
  assert.ok(alerts.some(text => /added/i.test(text)), `booking ${date} did not succeed: ${JSON.stringify(alerts)}`);
}

async function decideLeave(port, cookie, action, leaveId) {
  const result = await postForm(port, cookie, `/requests/${action}/`, {request: leaveId});
  assert.equal(result.status, 302, result.body.slice(0, 300));
  await consumeFlash(port, cookie, `${action} of leave ${leaveId}`);
  assert.ok(result.workerPid, `${action} did not record a worker pid`);
  return result.workerPid;
}

async function uploadUsersCsv(port, cookie, csvText) {
  const page = await request(port, '/calendar/', cookie);
  const csrf = extractCsrf(page.body);
  assert.ok(csrf, 'no CSRF token on /calendar/');
  const form = new FormData();
  form.set('_csrf', csrf);
  form.set('users_import', new Blob([csvText], {type: 'text/csv'}), 'employees.csv');
  const result = await fetch(`http://${HOST}:${port}/users/import/`, {
    method: 'POST',
    headers: {cookie, 'x-csrf-token': csrf},
    body: form,
    redirect: 'manual',
    signal: AbortSignal.timeout(1500),
  });
  return {status: result.status, body: await result.text(), workerPid: result.headers.get('x-test-worker-pid')};
}

// The HTML cache keys embed the version as getCompanyVersion returned it - the
// Redis GET string - so the key carries "cache_version":"7" (JSON string), and
// the department data-cache key (which embeds "version") must never match.
async function hasWarmedHtmlEntry(ctx, version) {
  const versionJson = JSON.stringify(String(version));
  const keys = await ctx.redis.keys('teamview:{*');
  return keys.some(key => key.includes('"user_id":') && key.includes(`"cache_version":${versionJson}`));
}

// One family cycle: run the family's pre-warm setup (bookings the warmed HTML
// must already contain), warm both workers through the same flash-free viewer
// session, record the shared version, mutate through one worker, consume the
// mutation flash, then read through the OTHER worker and assert the marker
// transition plus the version advance, all inside the TTL window.
async function runFamily(family, ctx) {
  const route = `/calendar/teamview/?date=${family.anchor}`;
  const cycleStartedAt = Date.now();

  if (family.setup) { await family.setup(ctx); }
  await request(ctx.port, '/calendar/', ctx.viewer.cookie);

  // The workers connect their cache clients lazily: the first cache operation
  // starts the connection, and until the client's ready event fires the cache
  // runs in the bypass policy and writes no HTML entry. Warm until a shared
  // entry actually exists at the current version - no mutation has happened
  // yet, so re-warming is content-neutral and stays inside the TTL budget.
  let warmA = null;
  let warmB = null;
  let versionBefore = 0;
  let warmed = false;
  for (let attempt = 0; attempt < 20 && !warmed; attempt++) {
    warmA = await requestFromWorker(ctx.port, ctx.workers[0], route, ctx.viewer.cookie);
    warmB = await requestFromWorker(ctx.port, ctx.workers[1], route, ctx.viewer.cookie);
    assert.equal(warmA.status, 200, warmA.body.slice(0, 400));
    assert.equal(warmB.status, 200, warmB.body.slice(0, 400));
    versionBefore = Number(await ctx.redis.get(ctx.versionKey));
    assert.ok(versionBefore > 0, `${family.name}: company version missing before the cycle`);
    warmed = await hasWarmedHtmlEntry(ctx, versionBefore);
    if (!warmed) { await wait(50); }
  }
  assert.ok(warmed, `${family.name}: team-view HTML never became cached ` +
    `(workers ${ctx.workers.join(',')} stayed in the cache bypass policy)`);

  if (family.pre) {
    assert.ok(family.pre(warmA.body) && family.pre(warmB.body),
      `${family.name}: warm pre-condition failed on one of the workers`);
  }
  if (family.direction === 'appears') {
    assert.ok(!family.marker(warmA.body) && !family.marker(warmB.body),
      `${family.name}: marker already present in the warmed HTML`);
  } else {
    assert.ok(family.marker(warmA.body) && family.marker(warmB.body),
      `${family.name}: marker missing from the warmed HTML`);
  }

  const mutationWorkerPid = String(await family.mutate(ctx));
  assert.ok(mutationWorkerPid, `${family.name}: mutation did not record a worker pid`);

  const readWorkerPid = mutationWorkerPid === String(ctx.workers[0]) ? ctx.workers[1] : ctx.workers[0];
  const post = await requestFromWorker(ctx.port, readWorkerPid, route, ctx.viewer.cookie);
  assert.equal(post.status, 200, post.body.slice(0, 400));
  assert.equal(String(post.workerPid), String(readWorkerPid), `${family.name}: read served by the wrong worker`);

  const versionAfter = Number(await ctx.redis.get(ctx.versionKey));
  const markerVisible = family.direction === 'appears'
    ? family.marker(post.body)
    : !family.marker(post.body);
  const elapsedMs = Date.now() - cycleStartedAt;

  assert.ok(versionAfter > versionBefore, `${family.name}: version did not advance ${versionBefore} -> ${versionAfter}`);
  assert.ok(markerVisible, `${family.name}: marker (${family.direction} ${family.markerLabel}) not visible in the other worker's read`);
  assert.ok(elapsedMs < 10000, `${family.name}: cycle took ${elapsedMs}ms; TTL could have contributed`);
  assert.notEqual(mutationWorkerPid, String(readWorkerPid), `${family.name}: read must come from the other worker`);

  process.stdout.write(`  family ${family.name}: v${versionBefore}->v${versionAfter} ${elapsedMs}ms ${family.direction} ${family.markerLabel}\n`);
  return {
    name: family.name,
    direction: family.direction,
    marker: family.markerLabel,
    version_advanced: versionAfter > versionBefore,
    marker_visible: markerVisible,
    elapsed_ms: elapsedMs,
    mutation_worker_pid: mutationWorkerPid,
    read_worker_pid: String(readWorkerPid),
    version_before: versionBefore,
    version_after: versionAfter,
  };
}

async function bootFamiliesCluster(env) {
  const port = Number(env.PORT);
  const proc = spawnInGroup(process.execPath, ['--require', __filename, 'bin/wwww_cluster'], {
    cwd: root, env: {...childBaseEnv, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
  }
  const watchdog = setTimeout(() => { terminateTree(proc, {graceMs: 100}).catch(() => {}); }, 300000);
  const redis = createClient({socket: {host: HOST, port: PORTS.redis}, RESP: 2});
  redis.on('error', () => {});
  try {
    await ready(port, proc, () => output);
    await redis.connect();
    // Every fresh database starts its ids from 1, so cache keys from earlier
    // cases against the same fixture (user_id 1, company_id 1, same month,
    // same version) would collide with this cluster's keys and serve foreign
    // HTML. The cluster owns the fixture for the duration: start clean.
    const staleKeys = await redis.keys('teamview:*');
    if (staleKeys.length) { await redis.del(staleKeys); }
    const workers = await discoverWorkers(port);
    return {port, proc, output: () => output, watchdog, redis, workers};
  } catch (error) {
    clearTimeout(watchdog);
    try { if (redis.isOpen) { await redis.quit(); } } catch { /* best-effort */ }
    await terminateTree(proc, {graceMs: 100});
    throw error;
  }
}

async function stopFamiliesCluster(cluster) {
  clearTimeout(cluster.watchdog);
  try {
    if (cluster.redis.isOpen) {
      const keys = await cluster.redis.keys('teamview:*');
      if (keys.length) { await cluster.redis.del(keys); }
    }
  } catch { /* best-effort owned cleanup */ }
  try { if (cluster.redis.isOpen) { await cluster.redis.quit(); } } catch { /* best-effort */ }
  cluster.proc.kill('SIGTERM');
  const stopped = await new Promise(resolve => cluster.proc.once('close', code => resolve(code)));
  assert.equal(stopped, 0, cluster.output());
  await terminateTree(cluster.proc, {graceMs: 100});
}

function familyDefinitions(tokens, seeded, plan, admin, database) {
  const {port} = tokens;
  const latestLeaveId = () => sqlOne(admin, database,
    `SELECT id FROM #DB#.\`Leaves\` WHERE userId = ${seeded.leaverId} ORDER BY id DESC LIMIT 1`)
    .then(row => row.id);
  const userIdByEmail = email => sqlOne(admin, database,
    `SELECT id FROM #DB#.\`Users\` WHERE email = '${email}'`).then(row => row.id);
  const idByName = (table, name) => sqlOne(admin, database,
    `SELECT id FROM #DB#.\`${table}\` WHERE name = '${name}'`).then(row => row.id);

  // Company-settings marker: the team view paints company-today with
  // current_day_cell; moving the company timezone moves that cell.
  const shifted = pickShiftedTimezone();
  const companyAnchor = `${shifted.londonToday.slice(0, 7)}-01`;
  const londonDay = Number(shifted.londonToday.slice(8, 10));
  const shiftedDay = Number(shifted.shiftedToday.slice(8, 10));
  const shiftedSameMonth = shifted.shiftedToday.slice(0, 7) === shifted.londonToday.slice(0, 7);
  const currentDay = html => {
    const match = html.match(/day_(\d+)(?=[^>]*current_day_cell)/);
    return match ? Number(match[1]) : null;
  };

  return [
    {
      name: 'leave_approve',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: 'approved leave cell class (leave_type_color_1)',
      marker: html => html.includes('leave_type_color_1'),
      pre: html => html.includes('leave_cell_pended'),
      async setup(ctx) {
        await bookLeave(port, ctx.leaver.cookie, seeded.leaveTypeId, plan.leaveDates[0]);
        tokens.approveLeaveId = await latestLeaveId();
      },
      async mutate(ctx) {
        return decideLeave(port, ctx.viewer.cookie, 'approve', tokens.approveLeaveId);
      },
    },
    {
      name: 'leave_reject',
      anchor: plan.anchor,
      direction: 'disappears',
      markerLabel: 'data-leave-id of the rejected leave',
      marker: html => html.includes(`data-leave-id="${tokens.rejectLeaveId}"`),
      pre: html => html.includes(`data-leave-id="${tokens.rejectLeaveId}"`),
      async setup(ctx) {
        await bookLeave(port, ctx.leaver.cookie, seeded.leaveTypeId, plan.leaveDates[1]);
        tokens.rejectLeaveId = await latestLeaveId();
      },
      async mutate(ctx) {
        return decideLeave(port, ctx.viewer.cookie, 'reject', tokens.rejectLeaveId);
      },
    },
    {
      name: 'leave_cancel',
      anchor: plan.anchor,
      direction: 'disappears',
      markerLabel: 'data-leave-id of the canceled leave',
      marker: html => html.includes(`data-leave-id="${tokens.cancelLeaveId}"`),
      pre: html => html.includes(`data-leave-id="${tokens.cancelLeaveId}"`),
      async setup(ctx) {
        await bookLeave(port, ctx.leaver.cookie, seeded.leaveTypeId, plan.leaveDates[2]);
        tokens.cancelLeaveId = await latestLeaveId();
      },
      async mutate(ctx) {
        return decideLeave(port, ctx.leaver.cookie, 'cancel', tokens.cancelLeaveId);
      },
    },
    {
      name: 'leave_revoke_request',
      anchor: plan.anchor,
      direction: 'disappears',
      markerLabel: 'data-leave-id of the revoked leave',
      marker: html => html.includes(`data-leave-id="${tokens.revokeLeaveId}"`),
      pre: html => html.includes(`data-leave-id="${tokens.revokeLeaveId}"`),
      async setup(ctx) {
        // The revoke request itself (approved -> pended_revoke) renders
        // identically to an approved leave in the team view, so the family
        // warms against an approved leave and drives the revocation to its
        // user-visible conclusion: the approver accepts the request, the
        // leave becomes rejected and leaves the team view entirely.
        await bookLeave(port, ctx.leaver.cookie, seeded.leaveTypeId, plan.leaveDates[3]);
        tokens.revokeLeaveId = await latestLeaveId();
        await decideLeave(port, ctx.viewer.cookie, 'approve', tokens.revokeLeaveId);
      },
      async mutate(ctx) {
        await decideLeave(port, ctx.leaver.cookie, 'revoke', tokens.revokeLeaveId);
        return decideLeave(port, ctx.viewer.cookie, 'approve', tokens.revokeLeaveId);
      },
    },
    {
      name: 'leave_bulk_approve',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: 'approved bulk-leave cell class (leave_type_color_5)',
      marker: html => html.includes('leave_type_color_5'),
      pre: html => html.includes('leave_cell_pended'),
      async setup(ctx) {
        await bookLeave(port, ctx.leaver.cookie, seeded.matrixLeaveTypeId, plan.leaveDates[4]);
        tokens.bulkFirstLeaveId = await latestLeaveId();
        await bookLeave(port, ctx.leaver.cookie, seeded.matrixLeaveTypeId, plan.leaveDates[5]);
        tokens.bulkSecondLeaveId = await latestLeaveId();
      },
      async mutate(ctx) {
        const result = await postForm(port, ctx.viewer.cookie, '/requests/bulk/approve/', {
          request: [tokens.bulkFirstLeaveId, tokens.bulkSecondLeaveId],
        });
        assert.equal(result.status, 302, result.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'bulk approve');
        assert.ok(result.workerPid);
        return result.workerPid;
      },
    },
    {
      name: 'user_create',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: `new user name (${tokens.userOneName})`,
      marker: html => html.includes(tokens.userOneName),
      async mutate(ctx) {
        const result = await postForm(port, ctx.viewer.cookie, '/users/add/', {
          name: tokens.userOneName,
          lastname: 'User',
          email_address: tokens.userOneEmail,
          department: seeded.departmentId,
          start_date: plan.anchor,
          end_date: '',
          password_one: FAMILY_PASSWORD,
          password_confirm: FAMILY_PASSWORD,
          admin: '0',
          auto_approve: '0',
        });
        assert.equal(result.status, 302, result.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'user create');
        assert.ok(result.workerPid);
        return result.workerPid;
      },
    },
    {
      name: 'user_update',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: `renamed user name (${tokens.userTwoName})`,
      marker: html => html.includes(tokens.userTwoName),
      pre: html => html.includes(tokens.userOneName),
      async mutate(ctx) {
        const createdUserId = await userIdByEmail(tokens.userOneEmail);
        const result = await postForm(port, ctx.viewer.cookie, `/users/edit/${createdUserId}/`, {
          name: tokens.userTwoName,
          lastname: 'User',
          email_address: tokens.userOneEmail,
          department: seeded.departmentId,
          start_date: plan.anchor,
          end_date: '',
          admin: '0',
          auto_approve: '0',
        });
        assert.equal(result.status, 302, result.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'user update');
        assert.ok(result.workerPid);
        return result.workerPid;
      },
    },
    {
      name: 'department_create',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: `new department name (${tokens.departmentOneName})`,
      marker: html => html.includes(tokens.departmentOneName),
      async mutate(ctx) {
        const result = await postForm(port, ctx.viewer.cookie, '/settings/departments/', {
          name__new: tokens.departmentOneName,
          allowance__new: '20',
          boss_id__new: seeded.viewerId,
          include_public_holidays__new: '1',
          is_accrued_allowance__new: '0',
        });
        assert.equal(result.status, 302, result.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'department create');
        assert.ok(result.workerPid);
        return result.workerPid;
      },
    },
    {
      name: 'department_update_supervisor',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: `renamed department name (${tokens.departmentTwoName})`,
      marker: html => html.includes(tokens.departmentTwoName),
      pre: html => html.includes(tokens.departmentOneName),
      async mutate(ctx) {
        const departmentId = await idByName('Departments', tokens.departmentOneName);
        const rename = await postForm(port, ctx.viewer.cookie, `/settings/departments/edit/${departmentId}/`, {
          name: tokens.departmentTwoName,
          allowance: '20',
          boss_id: seeded.viewerId,
          include_public_holidays: '1',
          is_accrued_allowance: '0',
        });
        assert.equal(rename.status, 302, rename.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'department rename');
        // Supervisor-link change: the transactional DepartmentSupervisor
        // destroy + bulkCreate flow from the departments edit route.
        const supervisors = await postForm(port, ctx.viewer.cookie, `/settings/departments/edit/${departmentId}/`, {
          do_add_supervisors: '1',
          supervisor_id: [String(seeded.leaverId)],
        });
        assert.equal(supervisors.status, 302, supervisors.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'supervisor link change');
        assert.ok(supervisors.workerPid);
        return supervisors.workerPid;
      },
    },
    {
      name: 'leave_type_create',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: 'new leave type cell class (leave_type_color_9)',
      marker: html => html.includes('leave_type_color_9'),
      async mutate(ctx) {
        const create = await postForm(port, ctx.viewer.cookie, '/settings/leavetypes', {
          name__new: tokens.leaveTypeName,
          color__new: 'leave_type_color_9',
          limit__new: '0',
          minimum_consecutive_days__new: '0',
          use_allowance__new: '1',
          auto_approve__new: '0',
        });
        assert.equal(create.status, 302, create.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'leave type create');
        const typeId = await idByName('LeaveTypes', tokens.leaveTypeName);
        // Book and approve one leave of the new type: a pending leave renders
        // leave_cell_pended, so the type's color class only reaches the team
        // view once a leave of that type is approved.
        await bookLeave(port, ctx.leaver.cookie, typeId, plan.leaveDates[6]);
        return decideLeave(port, ctx.viewer.cookie, 'approve', await latestLeaveId());
      },
    },
    {
      name: 'bank_holiday_create',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: `bank holiday tooltip name (${tokens.holidayName})`,
      marker: html => html.includes(tokens.holidayName),
      async mutate(ctx) {
        const result = await postForm(port, ctx.viewer.cookie, '/settings/bankholidays/', {
          name__new: tokens.holidayName,
          date__new: plan.holidayDate,
        });
        assert.equal(result.status, 302, result.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'bank holiday create');
        assert.ok(result.workerPid);
        return result.workerPid;
      },
    },
    {
      name: 'bank_holiday_preset_import',
      anchor: '2025-12-01',
      direction: 'appears',
      markerLabel: 'imported preset holiday name (Christmas Day)',
      marker: html => html.includes('Christmas Day'),
      async mutate(ctx) {
        // GB presets only carry 2023-2025 data; the route accepts an explicit
        // year, so import 2025 and anchor the reads on that December.
        const result = await postForm(port, ctx.viewer.cookie, '/settings/bankholidays/import/?year=2025', {});
        assert.equal(result.status, 302, result.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'bank holiday preset import');
        assert.ok(result.workerPid);
        return result.workerPid;
      },
    },
    {
      name: 'work_calendar_create',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: `calendar-scoped holiday tooltip name (${tokens.calendarHolidayName})`,
      marker: html => html.includes(tokens.calendarHolidayName),
      async mutate(ctx) {
        const calendar = await postForm(port, ctx.viewer.cookie, '/settings/bankholidays/calendars/', {
          name: tokens.calendarName,
        });
        assert.equal(calendar.status, 302, calendar.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'work calendar create');
        const calendarId = await idByName('WorkCalendars', tokens.calendarName);
        // A calendar only shapes the team view through a department: put a
        // holiday inside the calendar, then attach the calendar to the
        // populated department so the holiday becomes team-view visible.
        const holiday = await postForm(port, ctx.viewer.cookie, `/settings/bankholidays/?work_calendar=${calendarId}`, {
          name__new: tokens.calendarHolidayName,
          date__new: plan.calendarHolidayDate,
        });
        assert.equal(holiday.status, 302, holiday.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'calendar-scoped bank holiday create');
        const attach = await postForm(port, ctx.viewer.cookie, `/settings/departments/edit/${seeded.departmentId}/`, {
          name: 'Test',
          allowance: '20',
          boss_id: seeded.viewerId,
          include_public_holidays: '1',
          is_accrued_allowance: '0',
          work_calendar_id: calendarId,
        });
        assert.equal(attach.status, 302, attach.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'work calendar attach');
        assert.ok(attach.workerPid);
        return attach.workerPid;
      },
    },
    {
      name: 'schedule_save',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: `working-day shape flips Monday to weekend_cell (day ${Number(plan.scheduleMonday.slice(8, 10))})`,
      marker: html => html.includes(`day_${Number(plan.scheduleMonday.slice(8, 10))} weekend_cell`),
      async mutate(ctx) {
        // The schedule route sets every weekday from the body: send the
        // whole week with Monday switched off so the company schedule turns
        // that Monday into a non-working day (weekend_cell appears).
        const result = await postForm(port, ctx.viewer.cookie, '/settings/schedule/', {
          monday: '',
          tuesday: '1',
          wednesday: '1',
          thursday: '1',
          friday: '1',
          saturday: '',
          sunday: '',
        });
        assert.equal(result.status, 302, result.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'schedule save');
        assert.ok(result.workerPid);
        return result.workerPid;
      },
    },
    {
      name: 'company_settings_save',
      anchor: companyAnchor,
      direction: shiftedSameMonth ? 'appears' : 'disappears',
      markerLabel: `current-day cell moves with the company timezone (${shifted.londonToday} -> ${shifted.shiftedToday})`,
      marker: html => currentDay(html) === (shiftedSameMonth ? shiftedDay : londonDay),
      pre: html => currentDay(html) === londonDay,
      async mutate(ctx) {
        const result = await postForm(port, ctx.viewer.cookie, '/settings/company/', {
          name: 'CacheCase',
          country: 'GB',
          date_format: 'YYYY-MM-DD',
          timezone: shifted.zone,
          carry_over: '20',
          share_all_absences: '0',
          is_team_view_hidden: '0',
        });
        assert.equal(result.status, 302, result.body.slice(0, 300));
        await consumeFlash(port, ctx.viewer.cookie, 'company settings save');
        assert.ok(result.workerPid);
        return result.workerPid;
      },
    },
    {
      name: 'csv_import',
      anchor: plan.anchor,
      direction: 'appears',
      markerLabel: `imported employee names (${tokens.csvNameOne} and ${tokens.csvNameTwo})`,
      marker: html => html.includes(tokens.csvNameOne) && html.includes(tokens.csvNameTwo),
      async mutate(ctx) {
        const csv = [
          'email,lastname,name,department',
          `${tokens.csvEmailOne},User,${tokens.csvNameOne},Test`,
          `${tokens.csvEmailTwo},User,${tokens.csvNameTwo},Test`,
        ].join('\n');
        const result = await uploadUsersCsv(port, ctx.viewer.cookie, csv);
        assert.equal(result.status, 302, result.body.slice(0, 300));
        const alerts = await consumeFlash(port, ctx.viewer.cookie, 'csv import');
        assert.ok(alerts.some(text => text.includes(tokens.csvEmailOne)),
          `csv import did not confirm the employees: ${JSON.stringify(alerts)}`);
        assert.ok(result.workerPid);
        return result.workerPid;
      },
    },
  ];
}

async function runFamilies() {
  await prerequisite('redis');
  const entries = [];
  let workersCount = 0;

  await withDatabase('mysql', async (database, storage, admin) => {
    const port = await freePort();
    const env = familiesEnv('mysql', database, port, storage);
    const migration = await child(['bin/db_update.js'], env, 30000);
    assert.equal(migration.code, 0, migration.output);

    const runTag = crypto.randomBytes(4).toString('hex');
    const viewerEmail = `fam-viewer-${runTag}@example.test`;
    const leaverEmail = `fam-leaver-${runTag}@example.test`;
    const seeded = await seed(env, viewerEmail, leaverEmail);

    const cluster = await bootFamiliesCluster(env);
    try {
      const viewer = await login(cluster.port, viewerEmail);
      const leaver = await login(cluster.port, leaverEmail);
      await request(cluster.port, '/calendar/', viewer.cookie);
      await request(cluster.port, '/calendar/', leaver.cookie);

      const tokens = {
        port: cluster.port,
        userOneName: `Famcreate${runTag}`,
        userTwoName: `Famrenamed${runTag}`,
        userOneEmail: `fam-create-${runTag}@example.test`,
        departmentOneName: `Famdep${runTag}`,
        departmentTwoName: `Famdeptwo${runTag}`,
        leaveTypeName: `Famtype${runTag}`,
        holidayName: `Famhol${runTag}`,
        calendarName: `Famcal${runTag}`,
        calendarHolidayName: `Famcalhol${runTag}`,
        csvNameOne: `Csvone${runTag}`,
        csvNameTwo: `Csvtwo${runTag}`,
        csvEmailOne: `fam-csv-one-${runTag}@example.test`,
        csvEmailTwo: `fam-csv-two-${runTag}@example.test`,
      };

      const plan = workMonthPlan(dateInZone('Europe/London'));
      const ctx = {
        port: cluster.port,
        redis: cluster.redis,
        workers: cluster.workers,
        viewer,
        leaver,
        versionKey: `teamview:version:${seeded.companyId}`,
      };

      const families = familyDefinitions(tokens, seeded, plan, admin, database);
      for (const family of families) {
        entries.push(await runFamily(family, ctx));
      }
      workersCount = cluster.workers.length;
    } finally {
      await stopFamiliesCluster(cluster);
    }
  });

  // user_delete is destructive: it removes an employee the other families'
  // assertions reference, so it runs on its own fresh database and cluster
  // (the plan requires isolation over weakened assertions).
  await withDatabase('mysql', async (database, storage) => {
    const port = await freePort();
    const env = familiesEnv('mysql', database, port, storage);
    const migration = await child(['bin/db_update.js'], env, 30000);
    assert.equal(migration.code, 0, migration.output);

    const runTag = crypto.randomBytes(4).toString('hex');
    const viewerEmail = `fam-del-viewer-${runTag}@example.test`;
    const victimEmail = `fam-del-victim-${runTag}@example.test`;
    const seeded = await seed(env, viewerEmail, victimEmail);

    const cluster = await bootFamiliesCluster(env);
    try {
      const viewer = await login(cluster.port, viewerEmail);
      await request(cluster.port, '/calendar/', viewer.cookie);
      const ctx = {
        port: cluster.port,
        redis: cluster.redis,
        workers: cluster.workers,
        viewer,
        leaver: {cookie: null},
        versionKey: `teamview:version:${seeded.companyId}`,
      };
      entries.push(await runFamily({
        name: 'user_delete',
        anchor: `${dateInZone('Europe/London').slice(0, 7)}-01`,
        direction: 'disappears',
        markerLabel: 'deleted employee name (Leaver User)',
        marker: html => html.includes('Leaver User'),
        async mutate(context) {
          const result = await postForm(context.port, context.viewer.cookie,
            `/users/delete/${seeded.leaverId}/`, {});
          assert.equal(result.status, 302, result.body.slice(0, 300));
          await consumeFlash(context.port, context.viewer.cookie, 'user delete');
          assert.ok(result.workerPid);
          return result.workerPid;
        },
      }, ctx));
      workersCount = cluster.workers.length;
    } finally {
      await stopFamiliesCluster(cluster);
    }
  });

  assert.equal(entries.length, 17, `expected 17 family verdicts, got ${entries.length}`);
  const allPassed = entries.every(entry => entry.version_advanced && entry.marker_visible && entry.elapsed_ms < 10000);
  process.stdout.write(JSON.stringify({
    case: 'families',
    workers: workersCount,
    all_families_passed: allPassed,
    families: entries,
  }) + '\n');
}

async function main() {
  const [mode] = process.argv.slice(2);
  if (mode === '--prerequisite') { await prerequisite('redis'); return; }
  if (mode === '--case' && process.argv[3] === 'shared') { await runShared(); return; }
  if (mode === '--case' && process.argv[3] === 'families') { await runFamilies(); return; }
  throw new Error('Usage: cache_case.js --prerequisite redis | --case shared | --case families');
}
