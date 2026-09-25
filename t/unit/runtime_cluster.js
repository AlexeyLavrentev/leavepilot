'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const EventEmitter = require('node:events');
const {spawnInGroup, terminateGroup} = require('../../bin/lib/spawn_group');
const {startCluster} = require('../../lib/runtime_cluster');

const root = path.join(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') { return false; } throw error; }
};
const until = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) { await wait(25); }
  return Boolean(predicate());
};

function run(args, env, deadlineMs) {
  const child = spawnInGroup(process.execPath, args, {
    cwd: root, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let output = '';
  let result;
  child.on('message', message => messages.push(message));
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  child.once('exit', (code, signal) => { result = {code, signal}; });
  const watchdog = setTimeout(() => { if (!result) { child.kill('SIGKILL'); } }, deadlineMs);
  child.once('exit', () => clearTimeout(watchdog));
  return {child, messages, get output() { return output.slice(-3000); }, get result() { return result; }};
}

describe('cluster tracer, primary ownership and signal forwarding', function() {
  this.timeout(15000);
  it('serves migrated SQLite sessions from two workers and drains both signals without survivors', async function() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cluster-'));
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const env = {
      NODE_ENV: 'development', DB_DIALECT: 'sqlite', DB_STORAGE: path.join(directory, 'app.sqlite'),
      DB_LOGGING: 'false', PORT: String(port), HOST: '127.0.0.1',
      SESSION_SECRET: 'test-only-session-secret', CRYPTO_SECRET: 'test-only-crypto-secret',
      SILENCE_HTTP_LOGS: 'true', DISABLE_NOTIFICATIONS_POLLING: 'true',
    };
    let parent;
    let workerPids = [];
    try {
      const migration = run(['bin/db_update.js'], env, 12000);
      assert.equal(await until(() => migration.result, 12000), true, migration.output);
      assert.equal(migration.result.code, 0, migration.output);
      for (const signal of ['SIGTERM', 'SIGINT']) {
        parent = run(['t/fixtures/runtime/cluster_case.js'], env, 13000);
        assert.equal(await until(() => parent.messages.filter(message => message.type === 'cluster-ready').length === 2 || parent.result, 9000), true, parent.output);
        assert.equal(parent.result, undefined, parent.output);
        workerPids = parent.messages.filter(message => message.type === 'cluster-ready').map(message => message.pid);
        assert.equal(new Set(workerPids).size, 2);
        const base = `http://127.0.0.1:${port}/login/`;
        const first = await fetch(base, {headers: {connection: 'close'}});
        assert.equal(first.status, 200);
        const cookie = (first.headers.getSetCookie().find(value => value.startsWith('connect.sid=')) || '').split(';')[0];
        assert.match(cookie, /connect\.sid=/);
        const firstToken = (await first.text()).match(/name="_csrf" value="([a-f0-9]+)"/);
        assert.ok(firstToken);
        const served = new Set([Number(first.headers.get('x-test-worker-pid'))]);
        for (let i = 0; i < 30 && served.size < 2; i += 1) {
          const response = await fetch(base, {headers: {connection: 'close', cookie}});
          assert.equal(response.status, 200);
          served.add(Number(response.headers.get('x-test-worker-pid')));
          const token = (await response.text()).match(/name="_csrf" value="([a-f0-9]+)"/);
          assert.ok(token);
          assert.equal(token[1], firstToken[1], 'SQL session did not survive worker handoff');
        }
        assert.deepEqual([...served].sort(), [...workerPids].sort());
        parent.child.kill(signal);
        assert.equal(await until(() => parent.result, 12000), true, parent.output);
        assert.equal(parent.result.code, 0, parent.output);
        assert.equal(await until(() => workerPids.every(pid => !alive(pid)), 1000), true, parent.output);
        parent = null;
        workerPids = [];
      }
    } finally {
      if (parent) { await terminateGroup(parent.child, {graceMs: 200}); }
      for (const pid of workerPids) { if (alive(pid)) { process.kill(pid, 'SIGKILL'); } }
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('bounds an overdue owned worker and reports forced cleanup nonzero', async function() {
    const cluster = new EventEmitter();
    const owner = new EventEmitter();
    const signals = [];
    const worker = {id: 1, process: {kill: signal => {
      signals.push(signal);
      if (signal === 'SIGKILL') { setImmediate(() => cluster.emit('exit', worker, null, 'SIGKILL')); }
    }}};
    cluster.fork = () => worker;
    let code;
    startCluster({cluster, process: owner, workerCount: 1, shutdownMs: 20, forceReserveMs: 30,
      exit: value => { code = value; }, log: {warn: () => {}, error: () => {}}});
    owner.emit('SIGTERM');
    assert.equal(signals[0], 'SIGTERM');
    assert.equal(await until(() => code !== undefined, 200), true);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(code, 1);
  });
});
