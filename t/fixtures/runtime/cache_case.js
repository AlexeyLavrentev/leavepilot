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

// Model-mutating CLI contour (Pitfall 4): point the lazily-created cache
// client at the shared fixture so hook-driven bumps open a real socket the
// CLI process must close alongside its database connection.
if (process.env.TEST_CACHE_CLI_PRELOAD === '1') {
  require('../../../lib/config').set('sessionStore', {
    useRedis: true,
    redisConnectionConfiguration: {host: HOST, port: PORTS.redis},
  });
} else if (process.env.TEST_CACHE_CASE_PRELOAD === '1') {
  // Evaluated in the primary and in every worker before bin/wwww_cluster loads
  // the application. The primary keeps the cluster_case.js import guard (it must
  // never load application, cache or model code); every worker selects the
  // session store through the nconf seam and stamps X-Test-Worker-Pid so the
  // case can target workers.
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
    if (process.env.TEST_CACHE_CASE_STORE === 'sql') {
      // D-01 contour: SQL sessions and no shared coordination configured - the
      // clustered declaration (stamped by bin/wwww_cluster) then forces the
      // bypass-no-coordination cache policy.
      config.set('sessionStore', {useRedis: false});
    } else {
      config.set('sessionStore', {
        useRedis: true,
        redisConnectionConfiguration: {host: HOST, port: PORTS.redis},
      });
    }

    // D-05 contour: route ONLY the team-view cache client through a
    // controllable RESP2 fault proxy in front of the real Redis fixture (the
    // Phase 2 redis_session_case.js outage mechanism). Sessions keep their
    // direct connection so the cache degradation is observed without dragging
    // the session store onto its unready/exit track.
    const outageProxyPort = Number(process.env.TEST_CACHE_OUTAGE_PROXY_PORT);
    if (outageProxyPort) {
      const Module = require('node:module');
      const originalLoad = Module._load;
      Module._load = function(request, parent) {
        const loaded = originalLoad.apply(this, arguments);
        if (request === 'redis' && parent && /team_view_cache\.js$/.test(parent.filename)) {
          return {
            createClient: options => loaded.createClient({
              ...options,
              socket: {...(options && options.socket), host: HOST, port: outageProxyPort},
            }),
          };
        }
        return loaded;
      };
    }
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

// RESP2 fault proxy (the Phase 2 redis_session_case.js /
// redis_session_lifecycle.js outage mechanism): while blocked it destroys
// every existing connection and every new downstream connection, which the
// cache client's fail-fast socket options (disableOfflineQueue and
// connectTimeout from 03-01) turn into an immediate bypass instead of a hang.
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

const countOccurrences = (text, needle) => text.split(needle).length - 1;

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
    return await operation(name, storage, admin);
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
  return withDatabase('mysql', async (database, storage, admin) => {
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

      return {
        case: 'shared',
        workers: 2,
        cacheKeyWarmed: hasWarmedEntry,
        versionBefore: versionBeforeNumber,
        versionAfter: Number(versionAfter),
        versionAdvanced,
        leaveVisibleAcrossWorkers: leaveVisible,
        elapsedMs,
        signalExit: stopped.code,
      };
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
  assert.ok(booking.workerPid, `booking ${date} did not record a worker pid`);
  return String(booking.workerPid);
}

// Book one leave per attempt on a fresh working day until the wanted worker
// serves the POST: cluster round-robin cannot be told which worker to use,
// and re-POSTing the same date after a wrong-worker attempt would trip the
// overlap validation, so every attempt carries its own date.
async function bookLeaveThroughWorker(port, wantedPid, cookie, leaveTypeId, dates) {
  const deadline = Date.now() + 15000;
  for (const date of dates) {
    if (Date.now() >= deadline) { break; }
    const workerPid = await bookLeave(port, cookie, leaveTypeId, date);
    if (workerPid === String(wantedPid)) {
      return {date, workerPid};
    }
  }
  throw new Error(`worker ${wantedPid} never served a booking attempt`);
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

async function bootCluster(env) {
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

async function stopCluster(cluster) {
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

// Teardown for cases that assert their own SIGTERM exit code before calling
// this (waiting for a second 'close' event would hang).
async function teardownCluster(cluster) {
  clearTimeout(cluster.watchdog);
  try {
    if (cluster.redis.isOpen) {
      const keys = await cluster.redis.keys('teamview:*');
      if (keys.length) { await cluster.redis.del(keys); }
    }
  } catch { /* best-effort owned cleanup */ }
  try { if (cluster.redis.isOpen) { await cluster.redis.quit(); } } catch { /* best-effort */ }
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

    const cluster = await bootCluster(env);
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
      await stopCluster(cluster);
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

    const cluster = await bootCluster(env);
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
      await stopCluster(cluster);
    }
  });

  assert.equal(entries.length, 17, `expected 17 family verdicts, got ${entries.length}`);
  const allPassed = entries.every(entry => entry.version_advanced && entry.marker_visible && entry.elapsed_ms < 10000);
  return {
    case: 'families',
    workers: workersCount,
    all_families_passed: allPassed,
    families: entries,
  };
}

// ===== Bypass-no-coordination contour (CACHE-02, D-01) =====================
//
// A clustered deployment (bin/wwww_cluster stamps LEAVEPILOT_CLUSTERED) with
// no shared coordination configured (SQL session store) must recompute every
// team-view read and never cache anywhere. The decisive assertion is the
// stale-memory regression trap: warming the SAME viewer twice through worker
// A and then mutating through worker B must still leave worker A's very next
// read fresh - exactly the sequence that serves stale data if per-worker
// memory caching ever returns under a cluster.

async function runBypassNoCoordination() {
  await prerequisite('redis');
  return withDatabase('mysql', async (database, storage, admin) => {
    const port = await freePort();
    const env = {
      ...baseEnv('mysql', database, port, storage),
      TEST_CACHE_CASE_STORE: 'sql',
      // Explicit per the plan wording; bin/wwww_cluster stamps the same
      // declaration before forking when it is unset.
      LEAVEPILOT_CLUSTERED: '1',
    };
    const migration = await child(['bin/db_update.js'], env, 20000);
    assert.equal(migration.code, 0, migration.output);

    const runTag = crypto.randomBytes(4).toString('hex');
    const viewerEmail = `byp-viewer-${runTag}@example.test`;
    const leaverEmail = `byp-leaver-${runTag}@example.test`;
    const seeded = await seed(env, viewerEmail, leaverEmail);

    const cluster = await bootCluster(env);
    try {
      const viewer = await login(cluster.port, viewerEmail);
      const leaver = await login(cluster.port, leaverEmail);
      await request(cluster.port, '/calendar/', viewer.cookie);

      const plan = workMonthPlan(dateInZone('Europe/London'));
      const route = `/calendar/teamview/?date=${plan.anchor}`;
      const [workerA, workerB] = cluster.workers;

      // (a) The viewer's team view renders through BOTH workers.
      const firstB = await requestFromWorker(cluster.port, workerB, route, viewer.cookie);
      const firstA = await requestFromWorker(cluster.port, workerA, route, viewer.cookie);
      assert.equal(firstA.status, 200, firstA.body.slice(0, 400));
      assert.equal(firstB.status, 200, firstB.body.slice(0, 400));

      // (b) Warm the SAME viewer TWICE through worker A - more than enough
      // reads for a per-worker memory cache to have stabilized an entry -
      // then mutate through worker B and read through worker A immediately.
      const warmA1 = await requestFromWorker(cluster.port, workerA, route, viewer.cookie);
      const warmA2 = await requestFromWorker(cluster.port, workerA, route, viewer.cookie);
      assert.equal(warmA1.status, 200, warmA1.body.slice(0, 400));
      assert.equal(warmA2.status, 200, warmA2.body.slice(0, 400));

      const booking = await bookLeaveThroughWorker(cluster.port, workerB, leaver.cookie,
        seeded.leaveTypeId, plan.leaveDates);
      const leaveRow = await sqlOne(admin, database,
        `SELECT id FROM #DB#.\`Leaves\` WHERE date_start = '${booking.date}' ORDER BY id DESC LIMIT 1`);
      assert.ok(leaveRow && leaveRow.id, 'no leave row for the worker-B booking');

      const nextReadA = await requestFromWorker(cluster.port, workerA, route, viewer.cookie);
      assert.equal(nextReadA.status, 200, nextReadA.body.slice(0, 400));
      const mutationVisibleThroughWarmedWorker = nextReadA.body.includes(`data-leave-id="${leaveRow.id}"`);
      assert.ok(mutationVisibleThroughWarmedWorker,
        `worker A served stale content after a worker B mutation (booked leave ${leaveRow.id} on ${booking.date} is missing)`);

      // (c) The degraded policy is visible in the application output.
      const outputText = cluster.output();
      const bypassEventLogged = outputText.includes('team_view_cache_bypass')
        && outputText.includes('bypass-no-coordination');
      assert.ok(bypassEventLogged,
        `the bypass-no-coordination warn event is missing from the cluster output: ${outputText}`);

      // (d) Nothing was cached anywhere: the fixture store holds zero
      // teamview keys.
      const teamviewKeys = await cluster.redis.keys('teamview:*');
      assert.equal(teamviewKeys.length, 0,
        `bypass-no-coordination cached anyway: ${teamviewKeys.join(',')}`);

      cluster.proc.kill('SIGTERM');
      const stopped = await new Promise(resolve => cluster.proc.once('close', code => resolve(code)));
      assert.equal(stopped, 0, cluster.output());

      return {
        case: 'bypass-no-coordination',
        workers: cluster.workers.length,
        distinct_worker_pids: new Set(cluster.workers).size,
        reads_ok_both_workers: firstA.status === 200 && firstB.status === 200,
        mutation_visible_through_warmed_worker: mutationVisibleThroughWarmedWorker,
        mutation_worker_pid: booking.workerPid,
        read_worker_pid: String(workerA),
        bypass_event_logged: bypassEventLogged,
        teamview_keys_in_store: teamviewKeys.length,
        signal_exit: stopped,
      };
    } finally {
      await teardownCluster(cluster);
    }
  });
}

// ===== Store-outage contour (CACHE-02, D-05) ===============================
//
// With the shared store selected, a runtime outage of that store must degrade
// the team-view cache to bypass recompute WITHOUT exiting the process (the
// cache never copies the session unready/exit track) and resume caching once
// the store returns, with the company version advanced past its pre-outage
// value - the first post-recovery bump is what makes the stale pre-outage
// entry unreachable again (recovery coherence, D-09).

async function runStoreOutage() {
  await prerequisite('redis');
  const proxy = startProxy(HOST, PORTS.redis);
  const proxyPort = await proxy.listen();
  try {
    return await withDatabase('mysql', async (database, storage, admin) => {
      const port = await freePort();
      const env = {
        ...baseEnv('mysql', database, port, storage),
        TEST_CACHE_OUTAGE_PROXY_PORT: String(proxyPort),
      };
      const migration = await child(['bin/db_update.js'], env, 20000);
      assert.equal(migration.code, 0, migration.output);

      const runTag = crypto.randomBytes(4).toString('hex');
      const viewerEmail = `out-viewer-${runTag}@example.test`;
      const leaverEmail = `out-leaver-${runTag}@example.test`;
      const seeded = await seed(env, viewerEmail, leaverEmail);

      const cluster = await bootCluster(env);
      try {
        const viewer = await login(cluster.port, viewerEmail);
        const leaver = await login(cluster.port, leaverEmail);
        await request(cluster.port, '/calendar/', viewer.cookie);

        const plan = workMonthPlan(dateInZone('Europe/London'));
        const route = `/calendar/teamview/?date=${plan.anchor}`;
        const [workerA, workerB] = cluster.workers;
        const versionKey = `teamview:version:${seeded.companyId}`;
        const ctx = {
          port: cluster.port, redis: cluster.redis, workers: cluster.workers,
          viewer, leaver, versionKey,
        };

        // Warm both workers until the shared HTML entry exists at the current
        // version (workers connect their cache clients lazily, see 03-03).
        let versionBeforeOutage = 0;
        let warmed = false;
        for (let attempt = 0; attempt < 20 && !warmed; attempt++) {
          const warmA = await requestFromWorker(cluster.port, workerA, route, viewer.cookie);
          const warmB = await requestFromWorker(cluster.port, workerB, route, viewer.cookie);
          assert.equal(warmA.status, 200, warmA.body.slice(0, 400));
          assert.equal(warmB.status, 200, warmB.body.slice(0, 400));
          versionBeforeOutage = Number(await cluster.redis.get(versionKey));
          assert.ok(versionBeforeOutage > 0, 'company version missing before the outage');
          warmed = await hasWarmedHtmlEntry(ctx, versionBeforeOutage);
          if (!warmed) { await wait(50); }
        }
        assert.ok(warmed, 'team-view HTML never became cached before the outage');

        const modeEventsBeforePause = countOccurrences(cluster.output(), 'team_view_cache_mode');

        // ==== The outage window. ====
        proxy.setBlocked(true);

        // Reads through BOTH workers stay 200 with fresh recomputed content:
        // the fail-fast client options make the outage an immediate bypass,
        // not a hang (every helper here carries its own deadline).
        const outageReadA = await requestFromWorker(cluster.port, workerA, route, viewer.cookie);
        const outageReadB = await requestFromWorker(cluster.port, workerB, route, viewer.cookie);
        assert.equal(outageReadA.status, 200, outageReadA.body.slice(0, 400));
        assert.equal(outageReadB.status, 200, outageReadB.body.slice(0, 400));

        // The bypass-store-unavailable transition is visible in the output.
        await until(() => {
          const text = cluster.output();
          return text.includes('team_view_cache_bypass') && text.includes('bypass-store-unavailable');
        }, 5000, 'the bypass-store-unavailable transition to be logged');

        // Mutate while paused: the leaver books a fresh working day through
        // whichever worker serves; the bump cannot reach the store, and after
        // its bounded retry window the red team_view_invalidation_failed is
        // the honest D-09 record.
        const mutationPidDuringOutage = await bookLeave(cluster.port, leaver.cookie,
          seeded.leaveTypeId, plan.leaveDates[0]);
        const outageLeaveRow = await sqlOne(admin, database,
          `SELECT id FROM #DB#.\`Leaves\` WHERE date_start = '${plan.leaveDates[0]}' ORDER BY id DESC LIMIT 1`);
        assert.ok(outageLeaveRow && outageLeaveRow.id, 'no leave row for the during-outage booking');
        await until(() => cluster.output().includes('team_view_invalidation_failed'),
          5000, 'the during-outage bump failure to be logged');

        const otherPid = mutationPidDuringOutage === String(workerA) ? workerB : workerA;
        const outageFinalRead = await requestFromWorker(cluster.port, otherPid, route, viewer.cookie);
        assert.equal(outageFinalRead.status, 200, outageFinalRead.body.slice(0, 400));
        const mutationVisibleDuringOutage = outageFinalRead.body.includes(`data-leave-id="${outageLeaveRow.id}"`);
        assert.ok(mutationVisibleDuringOutage,
          `the during-outage mutation (leave ${outageLeaveRow.id}) was not visible through the other worker`);

        // No exit, no restart: the very same worker PIDs served the whole
        // outage window, the supervisor is still alive, and the session
        // store (on its direct connection) never entered its error track.
        assert.equal(cluster.proc.exitCode, null, 'the cluster exited during the store outage');
        const duringOutageOutput = cluster.output();
        assert.ok(!duringOutageOutput.includes('redis_session_store_error'),
          `the outage touched the session store: ${duringOutageOutput}`);

        // ==== Recovery. ====
        proxy.setBlocked(false);

        // Both workers' cache clients reconnect on their own; each logs a
        // team_view_cache_mode event when its ready event re-fires.
        const modeEventsTarget = modeEventsBeforePause + cluster.workers.length;
        await until(() => countOccurrences(cluster.output(), 'team_view_cache_mode') >= modeEventsTarget,
          15000, 'both workers to reconnect their cache clients');

        // The first post-recovery mutation advances the shared version.
        const recoveryMutationPid = await bookLeave(cluster.port, leaver.cookie,
          seeded.leaveTypeId, plan.leaveDates[1]);
        assert.ok(recoveryMutationPid, 'the post-recovery booking did not record a worker pid');
        await until(async () => Number(await cluster.redis.get(versionKey)) > versionBeforeOutage,
          10000, 'the company version to advance after the store returned');
        const versionAfterRecovery = Number(await cluster.redis.get(versionKey));
        assert.ok(versionAfterRecovery >= versionBeforeOutage + 1,
          `version ${versionAfterRecovery} did not reach ${versionBeforeOutage} + the during-outage mutations`);

        // Caching resumed in the same process: a fresh teamview key exists at
        // the advanced version after a post-recovery warm read.
        let resumedCaching = false;
        for (let attempt = 0; attempt < 20 && !resumedCaching; attempt++) {
          const warmA = await requestFromWorker(cluster.port, workerA, route, viewer.cookie);
          const warmB = await requestFromWorker(cluster.port, workerB, route, viewer.cookie);
          assert.equal(warmA.status, 200, warmA.body.slice(0, 400));
          assert.equal(warmB.status, 200, warmB.body.slice(0, 400));
          resumedCaching = await hasWarmedHtmlEntry(ctx, versionAfterRecovery);
          if (!resumedCaching) { await wait(50); }
        }
        assert.ok(resumedCaching, 'caching did not resume at the advanced version after the store returned');

        // The worker PID set observed after recovery is unchanged.
        const postRecoveryReadA = await requestFromWorker(cluster.port, workerA, route, viewer.cookie);
        const postRecoveryReadB = await requestFromWorker(cluster.port, workerB, route, viewer.cookie);
        assert.equal(postRecoveryReadA.status, 200, postRecoveryReadA.body.slice(0, 400));
        assert.equal(postRecoveryReadB.status, 200, postRecoveryReadB.body.slice(0, 400));
        const workerPidsUnchanged = cluster.proc.exitCode === null
          && String(postRecoveryReadA.workerPid) === String(workerA)
          && String(postRecoveryReadB.workerPid) === String(workerB);
        assert.ok(workerPidsUnchanged, 'the worker PID set changed across the outage window');

        // Pitfall 4 closure, proven on the real contour: a model-mutating CLI
        // under a Redis-configured environment exits within its bounded
        // lifetime once it closes the cache alongside sequelize (the
        // hook-driven bump opens a real socket against this same fixture; a
        // dangling socket would hold the child past the deadline).
        const cliEnv = {
          ...env,
          TEST_CACHE_CASE_PRELOAD: '',
          TEST_CACHE_CLI_PRELOAD: '1',
        };
        const cliExit = await child([
          '--require', __filename, 'bin/create_admin.js',
          '--email', `cli-exit-${runTag}@example.test`,
          '--company', 'CacheCaseCliExit',
          '--password', 'cli-exit-only-password',
        ], cliEnv, 20000);
        assert.equal(cliExit.code, 0, cliExit.output);

        cluster.proc.kill('SIGTERM');
        const stopped = await new Promise(resolve => cluster.proc.once('close', code => resolve(code)));
        assert.equal(stopped, 0, cluster.output());

        return {
          case: 'store-outage',
          workers: cluster.workers.length,
          cache_key_warmed_before_outage: warmed,
          version_before_outage: versionBeforeOutage,
          version_after_recovery: versionAfterRecovery,
          version_advanced: versionAfterRecovery > versionBeforeOutage,
          version_at_or_beyond_outage_mutations: versionAfterRecovery >= versionBeforeOutage + 1,
          reads_ok_during_outage: outageReadA.status === 200 && outageReadB.status === 200,
          mutation_visible_during_outage: mutationVisibleDuringOutage,
          bypass_transition_logged: true,
          invalidation_failure_logged: true,
          worker_pids_unchanged: workerPidsUnchanged,
          resumed_caching: resumedCaching,
          cli_bounded_exit: cliExit.code === 0,
          signal_exit: stopped,
        };
      } finally {
        await teardownCluster(cluster);
      }
    });
  } finally {
    await proxy.close();
  }
}

// ===== Suite mode (cache-correctness verify stage) =========================
//
// Every cache contour in one bounded invocation, in order: shared, families,
// bypass-no-coordination, store-outage. Each contour keeps its own fresh
// database and setup/teardown discipline (the functions above are reused
// verbatim); a contour that fails aborts the suite through its assertions, so
// the aggregate verdict line is only printed when every contour really
// completed - and the boolean is still derived from the verdict fields rather
// than assumed from the absence of a throw.

const SUITE_CONTOURS = [
  {id: 'shared', run: runShared},
  {id: 'families', run: runFamilies},
  {id: 'bypass-no-coordination', run: runBypassNoCoordination},
  {id: 'store-outage', run: runStoreOutage},
];

function contourPassed(id, verdict) {
  if (id === 'shared') {
    return verdict.cacheKeyWarmed === true && verdict.versionAdvanced === true
      && verdict.leaveVisibleAcrossWorkers === true && verdict.signalExit === 0;
  }
  if (id === 'families') { return verdict.all_families_passed === true; }
  if (id === 'bypass-no-coordination') {
    return verdict.mutation_visible_through_warmed_worker === true
      && verdict.bypass_event_logged === true
      && verdict.teamview_keys_in_store === 0
      && verdict.signal_exit === 0;
  }
  return verdict.reads_ok_during_outage === true
    && verdict.mutation_visible_during_outage === true
    && verdict.worker_pids_unchanged === true
    && verdict.resumed_caching === true
    && verdict.version_advanced === true
    && verdict.cli_bounded_exit === true
    && verdict.signal_exit === 0;
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
  if (mode === '--case' && process.argv[3] === 'shared') { printVerdict(await runShared()); return; }
  if (mode === '--case' && process.argv[3] === 'families') { printVerdict(await runFamilies()); return; }
  if (mode === '--case' && process.argv[3] === 'bypass-no-coordination') { printVerdict(await runBypassNoCoordination()); return; }
  if (mode === '--case' && process.argv[3] === 'store-outage') { printVerdict(await runStoreOutage()); return; }
  throw new Error('Usage: cache_case.js --prerequisite redis | --suite | --case shared | --case families | --case bypass-no-coordination | --case store-outage');
}
