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
const MYSQL_HOST = '127.0.0.1';
const PORTS = {mysql: 13306, redis: 16379, engram: 16380};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const childBaseEnv = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key])
  .map(key => [key, process.env[key]]));

// The preload is evaluated separately in every worker, before app.js loads.
// The primary never loads the application or a selected Store.
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
    process.stderr.write(`${error.message}\n`);
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

async function prerequisite(selection = 'all') {
  exactInputs();
  const checks = selection === 'all' ? ['mysql', 'redis', 'engram'] : [selection];
  assert.ok(checks.every(check => Object.hasOwn(PORTS, check)), 'Unknown prerequisite selection');
  for (const check of checks) {
    if (check === 'mysql') {
      const db = sqlConnection(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD);
      try { await db.authenticate(); }
      catch { throw new Error(`missing-prerequisite: MySQL 8 at ${MYSQL_HOST}:${PORTS.mysql}. Setup: ${SETUP}`); }
      finally { await db.close(); }
    } else { await pingResp(PORTS[check]); }
  }
  process.stdout.write(`${checks.join(' ')} ready\n`);
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
  const result = await fetch(`http://${MYSQL_HOST}:${port}${route}`, {
    ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(1500),
  });
  return {status: result.status, body: await result.text(),
    cookie: result.headers.getSetCookie().find(item => item.startsWith('connect.sid='))?.split(';')[0],
    location: result.headers.get('location')};
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

function baseEnv(dialect, database, backend, entrypoint, port, storage) {
  return {
    NODE_ENV: 'test', TZ: 'UTC', DB_DIALECT: dialect, DB_NAME: database,
    DB_HOST: MYSQL_HOST, DB_PORT: String(PORTS.mysql), DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD, DB_STORAGE: storage, DB_LOGGING: 'false',
    PORT: String(port), HOST: MYSQL_HOST, SESSION_SECRET: 'matrix-only-session-secret',
    CRYPTO_SECRET: 'matrix-only-crypto-secret', SILENCE_HTTP_LOGS: 'true',
    DISABLE_AUTH_RATE_LIMIT: 'true', DISABLE_NOTIFICATIONS_POLLING: 'true',
    LEAVEPILOT_EDITION: 'community', TEST_RUNTIME_MATRIX_PRELOAD: '1',
    TEST_RUNTIME_MATRIX_BACKEND: backend, TEST_RUNTIME_MATRIX_ENTRYPOINT: entrypoint,
    TEST_RUNTIME_MATRIX_STORE_PORT: String(PORTS[backend] || 0),
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
  `], env, 7000);
  assert.equal(result.code, 0, result.output);
}

async function withDatabase(dialect, operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-runtime-matrix-'));
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
    await operation(name, storage);
  } finally {
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS \`${name}\``); }
      finally { await admin.close(); }
    }
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

async function runCase(dialect, backend, entrypoint) {
  assert.ok(['sqlite', 'mysql'].includes(dialect));
  assert.ok(['sql', 'redis', 'engram'].includes(backend));
  assert.ok(['direct', 'cluster'].includes(entrypoint));
  await prerequisite(dialect === 'mysql' ? 'all' : backend === 'sql' ? 'mysql' : backend);
  await withDatabase(dialect, async (database, storage) => {
    const port = await freePort();
    const env = baseEnv(dialect, database, backend, entrypoint, port, storage);
    const migration = await child(['bin/db_update.js'], env, 12000);
    assert.equal(migration.code, 0, migration.output);
    const email = `runtime-${crypto.randomBytes(6).toString('hex')}@example.test`;
    await seed(env, email);
    const proc = spawnInGroup(process.execPath, ['--require', __filename,
      entrypoint === 'direct' ? 'bin/wwww' : 'bin/wwww_cluster'], {
      cwd: root, env: {...childBaseEnv, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
    }
    const watchdog = setTimeout(() => { terminateTree(proc, {graceMs: 100}).catch(() => {}); }, 30000);
    try {
      const page = await ready(port, proc, () => output);
      const csrf = page.body.match(/name=["']_csrf["'][^>]*value=["']([^"']+)/i)?.[1];
      assert.ok(csrf, output);
      const login = await request(port, '/login/', page.cookie, {
        method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf},
        body: new URLSearchParams({_csrf: csrf, email, password: 'matrix-only-password'}),
      });
      assert.equal(login.status, 302, output);
      const cookie = login.cookie;
      assert.match(cookie || '', /^connect\.sid=/);
      assert.equal((await request(port, '/calendar/', cookie)).status, 200, output);
      const logout = await request(port, '/logout/', cookie);
      assert.equal(logout.status, 302, output);
      proc.kill('SIGTERM');
      const stopped = await new Promise(resolve => proc.once('close', (code, signal) => resolve({code, signal})));
      assert.equal(stopped.code, 0, output);
      process.stdout.write(JSON.stringify({dialect, backend, entrypoint, migrated: true,
        sessionWriteRead: true, loginLogout: true, signalExit: stopped.code}) + '\n');
    } finally {
      clearTimeout(watchdog);
      await terminateTree(proc, {graceMs: 100});
    }
  });
}

async function runFault(dialect, fault, entrypoint) {
  assert.ok(['sqlite', 'mysql'].includes(dialect));
  assert.ok(['schema', 'credentials'].includes(fault));
  assert.ok(['direct', 'cluster'].includes(entrypoint));
  if (fault === 'credentials') { assert.equal(dialect, 'mysql'); }
  await prerequisite('mysql');
  await withDatabase(dialect, async (database, storage) => {
    const port = await freePort();
    const env = baseEnv(dialect, database, 'sql', entrypoint, port, storage);
    if (fault === 'credentials') {
      const migrated = await child(['bin/db_update.js'], env, 12000);
      assert.equal(migrated.code, 0, migrated.output);
      env.DB_PASSWORD = 'invalid-test-only-password';
    }
    const result = await child(['--require', __filename,
      entrypoint === 'direct' ? 'bin/wwww' : 'bin/wwww_cluster'], env, 12000);
    assert.equal(result.code, 1, result.output);
    await assert.rejects(request(port, '/login/'), /fetch failed/i);
    process.stdout.write(JSON.stringify({dialect, fault, entrypoint, nonzero: true,
      listenerClosed: true}) + '\n');
  });
}

async function runSessionSuite(backend) {
  assert.ok(['redis', 'engram'].includes(backend));
  await prerequisite(backend);
  const port = PORTS[backend];
  const token = crypto.randomBytes(20).toString('hex');
  const client = createClient({socket: {host: MYSQL_HOST, port}, RESP: 2});
  client.on('error', () => {});
  try {
    await client.connect();
    await client.set('lp:phase02:session-owner', token);
    const env = {
      TZ: 'UTC',
      TEST_SESSION_HOST: MYSQL_HOST,
      TEST_SESSION_PORT: String(port),
      TEST_SESSION_BACKEND: 'redis',
      TEST_SESSION_OWNERSHIP_TOKEN: token,
    };
    const result = await child(['node_modules/mocha/bin/mocha',
      't/runtime/redis_session_lifecycle.js', '--timeout', '10000',
      '--require', 't/lib/skip_honesty.js'], env, 60000);
    assert.equal(result.code, 0, result.output);
    process.stdout.write(`${backend} real RESP2 lifecycle passed\n${result.output}`);
  } finally {
    try {
      if (client.isOpen && await client.get('lp:phase02:session-owner') === token) {
        await client.del('lp:phase02:session-owner');
      }
    } finally {
      if (client.isOpen) { await client.quit(); }
    }
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--prerequisite') { await prerequisite(args[0]); return; }
  if (mode === '--case') { await runCase(args[0], args[1], args[2]); return; }
  if (mode === '--fault') { await runFault(args[0], args[1], args[2]); return; }
  if (mode === '--session-suite') { await runSessionSuite(args[0]); return; }
  throw new Error('Usage: runtime_matrix_case.js --prerequisite [all|mysql|redis|engram] | --case <dialect> <backend> <direct|cluster> | --fault <dialect> <schema|credentials> <direct|cluster> | --session-suite <redis|engram>');
}
