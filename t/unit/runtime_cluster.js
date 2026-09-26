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
        if (signal === 'SIGTERM') {
          const lost = parent.messages.find(message => message.type === 'cluster-ready');
          parent.child.send({type: 'kill-worker', workerId: lost.workerId});
          assert.equal(await until(() => parent.messages.filter(message => message.type === 'cluster-ready').length === 3 || parent.result, 8000), true, parent.output);
          assert.equal(parent.result, undefined, parent.output);
          const replacement = parent.messages.filter(message => message.type === 'cluster-ready')[2];
          assert.notEqual(replacement.pid, lost.pid);
          workerPids.push(replacement.pid);
          assert.equal(await until(() => !alive(lost.pid), 1000), true, parent.output);
          let replacementServed = false;
          for (let i = 0; i < 30 && !replacementServed; i += 1) {
            const response = await fetch(base, {headers: {connection: 'close', cookie}});
            assert.equal(response.status, 200);
            replacementServed = Number(response.headers.get('x-test-worker-pid')) === replacement.pid;
            const token = (await response.text()).match(/name="_csrf" value="([a-f0-9]+)"/);
            assert.ok(token);
            assert.equal(token[1], firstToken[1], 'SQL session did not survive replacement');
          }
          assert.equal(replacementServed, true, 'replacement did not serve traffic');
        }
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

describe('cluster replacement policy', function() {
  function supervisor({failForks = 0, workerCount = 1} = {}) {
    const cluster = new EventEmitter();
    const owner = new EventEmitter();
    const timers = [];
    const workers = [];
    const exits = [];
    let nextId = 0;
    let forkCount = 0;
    cluster.fork = () => {
      forkCount += 1;
      if (forkCount <= failForks) { throw Object.assign(new Error('fork failed'), {code: 'EAGAIN'}); }
      const worker = {id: ++nextId, process: {kill: signal => {
        worker.signals.push(signal);
        cluster.emit('exit', worker, null, signal);
      }}, signals: []};
      workers.push(worker);
      return worker;
    };
    const schedule = (callback, delay) => {
      const timer = {callback, delay, canceled: false};
      timers.push(timer);
      return timer;
    };
    startCluster({cluster, process: owner, workerCount, delays: [250, 500, 1000],
      setTimeout: schedule, clearTimeout: timer => { if (timer) { timer.canceled = true; } },
      exit: code => exits.push(code), log: {warn: () => {}, error: () => {}}});
    return {cluster, owner, timers, workers, exits,
      get forkCount() { return forkCount; },
      fireNext() {
        const timer = timers.find(candidate => !candidate.canceled && !candidate.fired);
        assert.ok(timer, 'expected a pending timer');
        timer.fired = true;
        timer.callback();
        return timer.delay;
      },
    };
  }

  it('counts fork failures within the same three-replacement budget', function() {
    const run = supervisor({failForks: 4});
    assert.equal(run.forkCount, 1);
    assert.deepEqual([run.fireNext(), run.fireNext(), run.fireNext()], [250, 500, 1000]);
    assert.equal(run.forkCount, 4);
    assert.deepEqual(run.exits, [1]);
    assert.equal(run.timers.filter(timer => !timer.canceled && !timer.fired).length, 0);
  });

  for (const [code, signal] of [[0, null], [1, null], [null, 'SIGKILL']]) {
    it(`replaces ${signal || `exit ${code}`} three times, then stops peers nonzero`, function() {
      const run = supervisor({workerCount: 2});
      const peer = run.workers[1];
      let lost = run.workers[0];
      for (const delay of [250, 500, 1000]) {
        run.cluster.emit('exit', lost, code, signal);
        assert.equal(run.fireNext(), delay);
        lost = run.workers.at(-1);
        run.cluster.emit('message', lost, {type: 'test-server-ready'});
      }
      run.cluster.emit('exit', lost, code, signal);
      assert.equal(run.forkCount, 5);
      assert.deepEqual(run.exits, [1]);
      assert.deepEqual(peer.signals, ['SIGTERM']);
    });
  }

  it('keeps one replacement per slot under simultaneous losses and ignores stale callbacks', function() {
    const run = supervisor({workerCount: 2});
    const [first, second] = run.workers;
    run.cluster.emit('exit', first, 1, null);
    run.cluster.emit('exit', second, 1, null);
    run.cluster.emit('exit', first, 1, null);
    run.cluster.emit('message', first, {type: 'test-server-ready'});
    assert.equal(run.fireNext(), 250);
    assert.equal(run.fireNext(), 250);
    assert.equal(run.forkCount, 4);
    assert.deepEqual(run.exits, []);
    run.owner.emit('SIGTERM');
    assert.deepEqual(run.exits, [0]);
  });

  it('cancels a pending replacement when stopping', function() {
    const run = supervisor();
    run.cluster.emit('exit', run.workers[0], 1, null);
    run.owner.emit('SIGTERM');
    assert.deepEqual(run.exits, [0]);
    const lateTimer = run.timers[0];
    assert.equal(lateTimer.canceled, true);
    lateTimer.callback();
    assert.equal(run.forkCount, 1);
  });

  it('does not replace a worker that exits during boot shutdown', function() {
    const run = supervisor();
    const booting = run.workers[0];
    run.owner.emit('SIGINT');
    run.cluster.emit('message', booting, {type: 'test-server-ready'});
    assert.deepEqual(run.exits, [0]);
    assert.equal(run.forkCount, 1);
  });
});
