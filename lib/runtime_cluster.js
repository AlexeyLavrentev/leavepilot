'use strict';

const clusterModule = require('node:cluster');
const logger = require('./middleware/request_logger');

const DEFAULT_DELAYS_MS = [250, 500, 1000];
const DEFAULT_SHUTDOWN_MS = 12000;
const DEFAULT_FORCE_RESERVE_MS = 500;

function startCluster(options = {}) {
  const cluster = options.cluster || clusterModule;
  const owner = options.process || process;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const exit = options.exit || (code => owner.exit(code));
  const log = options.log || logger;
  const workerCount = options.workerCount === undefined ? 2 : options.workerCount;
  const delays = options.delays || DEFAULT_DELAYS_MS;
  const shutdownMs = options.shutdownMs === undefined ? DEFAULT_SHUTDOWN_MS : options.shutdownMs;
  const forceReserveMs = options.forceReserveMs === undefined ? DEFAULT_FORCE_RESERVE_MS : options.forceReserveMs;
  if (!Number.isInteger(workerCount) || workerCount < 1 ||
      !Array.isArray(delays) || delays.length === 0 ||
      delays.some(delay => !Number.isFinite(delay) || delay < 0) ||
      !Number.isFinite(shutdownMs) || shutdownMs <= 0 ||
      !Number.isFinite(forceReserveMs) || forceReserveMs <= 0) {
    throw new Error('invalid cluster supervisor bounds');
  }

  const slots = Array.from({length: workerCount}, (_, index) => ({index, worker: null, attempts: 0, timer: null, ready: false}));
  let stopping = false;
  let requestedCode = 0;
  let deadlineTimer;
  let reserveTimer;
  let finished = false;

  function liveWorkers() {
    return slots.filter(slot => slot.worker).map(slot => slot.worker);
  }

  function finish() {
    if (finished || !stopping || liveWorkers().length !== 0) { return; }
    finished = true;
    clearTimer(deadlineTimer);
    clearTimer(reserveTimer);
    exit(requestedCode);
  }

  function signalWorker(worker, signal) {
    try {
      worker.process.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        log.error('cluster_worker_signal_failed', {workerId: worker.id, code: error.code});
        requestedCode = 1;
      }
    }
  }

  function stop(signal = 'SIGTERM', code = 0) {
    if (code !== 0) { requestedCode = code; }
    if (stopping) { return; }
    stopping = true;
    for (const slot of slots) {
      clearTimer(slot.timer);
      slot.timer = null;
    }
    // A worker owns its own HTTP, Store, cache and SQL shutdown order.
    for (const worker of liveWorkers()) { signalWorker(worker, signal); }
    deadlineTimer = setTimer(() => {
      if (liveWorkers().length === 0) { finish(); return; }
      requestedCode = 1;
      log.error('cluster_shutdown_incomplete', {workerCount: liveWorkers().length});
      for (const worker of liveWorkers()) { signalWorker(worker, 'SIGKILL'); }
      reserveTimer = setTimer(() => {
        if (finished) { return; }
        finished = true;
        exit(1);
      }, forceReserveMs);
    }, shutdownMs);
    finish();
  }

  function forkSlot(slot) {
    if (stopping || slot.worker) { return; }
    try {
      const worker = cluster.fork();
      slot.worker = worker;
      slot.ready = false;
    } catch (error) {
      log.error('cluster_fork_failed', {slot: slot.index, code: error.code});
      stop('SIGTERM', 1);
    }
  }

  cluster.on('message', (worker, message) => {
    const slot = slots.find(candidate => candidate.worker === worker);
    if (!stopping && slot && message && message.type === 'test-server-ready') {
      slot.ready = true;
    }
  });
  cluster.on('exit', (worker, code, signal) => {
    const slot = slots.find(candidate => candidate.worker === worker);
    if (!slot) { return; }
    slot.worker = null;
    slot.ready = false;
    if (stopping) { finish(); return; }
    const category = signal ? 'signal' : code === 0 ? 'clean_exit' : 'error_exit';
    log.warn('cluster_worker_lost', {workerId: worker.id, slot: slot.index, attempt: slot.attempts, category});
    if (slot.attempts >= delays.length) {
      log.error('cluster_replacement_exhausted', {slot: slot.index, attempts: slot.attempts});
      stop('SIGTERM', 1);
      return;
    }
    const delay = delays[slot.attempts];
    slot.attempts += 1;
    slot.timer = setTimer(() => {
      slot.timer = null;
      forkSlot(slot);
    }, delay);
  });
  owner.on('SIGTERM', () => stop('SIGTERM'));
  owner.on('SIGINT', () => stop('SIGINT'));
  owner.on('uncaughtException', error => {
    log.error('cluster_uncaught_exception', {code: error.code});
    stop('SIGTERM', 1);
  });
  owner.on('unhandledRejection', error => {
    log.error('cluster_unhandled_rejection', {code: error && error.code});
    stop('SIGTERM', 1);
  });

  for (const slot of slots) { forkSlot(slot); }
  return {stop};
}

module.exports = {startCluster};
