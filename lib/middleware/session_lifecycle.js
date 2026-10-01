'use strict';

const {randomBytes} = require('node:crypto');

// Policy constants finalized by the plan 08 measurements: retention
// rationale and observed evidence are recorded in
// t/fixtures/verify/runtime_timings.json (lifecycle.policy). The recovery
// window is symmetric with the runtime startup deadline; operation and
// close ceilings bound one Store callback and a graceful client close while
// healthy round-trips measure single-digit milliseconds.
const RECOVERY_TIMEOUT_MS = 20000;
const OPERATION_TIMEOUT_MS = 1000;
const CLOSE_TIMEOUT_MS = 1000;
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'SOCKET_CLOSED', 'SOCKET_TIMEOUT',
]);
const TRANSPORT_NAMES = new Set([
  'SocketClosedUnexpectedlyError', 'SocketTimeoutError', 'ClientClosedError',
  'DisconnectsClientError', 'ConnectionTimeoutError',
]);

function safeCode(error) {
  return error && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code : undefined;
}

function categoryOf(error) {
  const code = safeCode(error);
  if (TRANSPORT_CODES.has(code) || code === 'SESSION_STORE_UNAVAILABLE'
      || TRANSPORT_NAMES.has(error && error.name)) {
    return 'transport';
  }
  const message = error && typeof error.message === 'string' ? error.message : '';
  if (message === 'Socket closed unexpectedly' || message === 'Connection timeout'
      || message === 'The client is offline' || message === 'The client is closed'
      || message.startsWith('Socket timeout timeout.')) {
    return 'transport';
  }
  if (/^(WRONGPASS|NOAUTH|NOPERM)\b/i.test(message)) { return 'permission'; }
  if (/^(ERR (invalid password|unknown command|unsupported protocol)|NOPROTO)\b/i.test(message)) {
    return 'configuration';
  }
  return 'unknown';
}

function unavailableError(category = 'transport', code) {
  const error = new Error(`session_store_${category}`);
  error.code = code && TRANSPORT_CODES.has(code) ? code : 'SESSION_STORE_UNAVAILABLE';
  return error;
}

async function probeStore(call) {
  const sid = randomBytes(18).toString('hex');
  const payload = {
    cookie: {expires: new Date(Date.now() + 5000).toISOString()},
    marker: randomBytes(18).toString('hex'),
  };
  try {
    await call('set', sid, payload);
    const stored = await call('get', sid);
    if (JSON.stringify(stored) !== JSON.stringify(payload)) {
      throw new Error('session_probe_mismatch');
    }
    await call('touch', sid, payload);
    await call('destroy', sid);
  } finally {
    // Destroying twice covers a partial write; a failed cleanup is bounded too.
    try { await call('destroy', sid); }
    catch { /* The selected Store remains unready. */ }
  }
}

function createSessionLifecycle({store, client, recoveryTimeoutMs = RECOVERY_TIMEOUT_MS,
  operationTimeoutMs = OPERATION_TIMEOUT_MS, closeTimeoutMs = CLOSE_TIMEOUT_MS,
  onOperationFailure = () => {}, logger}) {
  for (const [name, value] of Object.entries({recoveryTimeoutMs, operationTimeoutMs, closeTimeoutMs})) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a finite positive number`);
    }
  }
  let state = 'created';
  let initializePromise;
  let closePromise;
  let recoveryTimer;
  let probeTimer;
  let probePromise;
  const pending = new Set();
  const listeners = new Set();
  const original = Object.fromEntries(['get', 'set', 'touch', 'destroy']
    .map(method => [method, store[method].bind(store)]));

  const notify = (nextState, error) => {
    if (state === 'closed' || state === 'failed') { return; }
    state = nextState;
    for (const listener of listeners) { listener({state: nextState, error}); }
  };
  const cancelPending = () => {
    for (const cancel of [...pending]) { cancel(unavailableError()); }
  };
  const clearTimers = () => {
    clearTimeout(recoveryTimer);
    clearTimeout(probeTimer);
    recoveryTimer = null;
    probeTimer = null;
  };
  const fail = (category, code) => {
    if (state === 'failed' || state === 'closed') { return; }
    notify('failed', unavailableError(category, code));
    clearTimers();
    cancelPending();
    client.destroy();
  };
  const onError = error => {
    if (state === 'failed' || state === 'closed') { return; }
    const category = categoryOf(error);
    logger.error('redis_session_store_error', {category, code: safeCode(error)});
    if (category !== 'transport') {
      fail(category);
      return;
    }
    if (state !== 'ready') { return; }
    notify('unready');
    recoveryTimer = setTimeout(() => fail('deadline'), recoveryTimeoutMs);
  };

  const callStore = (method, args) => new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) { return; }
      finished = true;
      clearTimeout(timer);
      pending.delete(cancel);
      if (error) { reject(error); }
      else { resolve(value); }
    };
    const cancel = error => finish(error);
    pending.add(cancel);
    const timer = setTimeout(() => finish(unavailableError()), operationTimeoutMs);
    try {
      const returned = original[method](...args, finish);
      if (returned && typeof returned.catch === 'function') {
        returned.catch(error => finish(error));
      }
    } catch (error) { finish(error); }
  });

  Object.keys(original).forEach(method => {
    store[method] = (...args) => {
      const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
      const operation = state === 'ready'
        ? callStore(method, args).catch(error => {
          onError(error);
          throw unavailableError(categoryOf(error));
        })
        : Promise.reject(unavailableError());
      const monitored = operation.catch(error => {
        onOperationFailure();
        throw error;
      });
      if (!callback) { return monitored; }
      monitored.then(result => callback(null, result), error => callback(error));
      return undefined;
    };
  });

  const verifyRecovery = () => {
    if (state !== 'unready' || probePromise) { return; }
    probePromise = probeStore((method, ...args) => callStore(method, args)).then(() => {
      if (state !== 'unready') { return; }
      clearTimers();
      notify('ready');
    }, error => {
      if (state !== 'unready') { return; }
      const category = categoryOf(error);
      logger.warn('redis_session_probe_failed', {category, code: safeCode(error)});
      if (category === 'permission' || category === 'configuration' || category === 'unknown') {
        fail(category);
      }
    }).finally(() => {
      probePromise = null;
      if (state === 'unready') {
        probeTimer = setTimeout(verifyRecovery, Math.min(100, operationTimeoutMs));
      }
    });
  };
  const onReady = () => { verifyRecovery(); };
  client.on('error', onError);
  client.on('ready', onReady);

  const forceClose = () => {
    state = 'closed';
    clearTimers();
    cancelPending();
    client.destroy();
    client.off('error', onError);
    client.off('ready', onReady);
    listeners.clear();
    return Promise.resolve();
  };

  return {
    initialize() {
      if (state === 'closed' || state === 'failed') {
        return Promise.reject(unavailableError());
      }
      if (!initializePromise) {
        let startupTimer;
        const deadline = new Promise((_, reject) => {
          startupTimer = setTimeout(() => {
            fail('deadline');
            reject(unavailableError('deadline'));
          }, recoveryTimeoutMs);
        });
        initializePromise = Promise.race([Promise.resolve().then(() => client.connect()), deadline])
          .then(() => probeStore((method, ...args) => callStore(method, args)))
          .then(() => {
            if (state === 'created') { notify('ready'); }
            else { throw unavailableError(); }
          }, error => {
            const category = categoryOf(error);
            logger.error('redis_session_startup_error', {category, code: safeCode(error)});
            if (category !== 'transport') { fail(category); }
            throw unavailableError(category, safeCode(error));
          }).finally(() => { clearTimeout(startupTimer); });
      }
      return initializePromise;
    },
    isReady: () => state === 'ready',
    reportFailure: error => fail(categoryOf(error), safeCode(error)),
    onStateChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      if (!closePromise) {
        state = 'closed';
        clearTimers();
        cancelPending();
        client.off('ready', onReady);
        listeners.clear();
        closePromise = Promise.resolve().then(async () => {
          if (client.isOpen) {
            let timer;
            try {
              await Promise.race([
                client.close(),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(unavailableError()), closeTimeoutMs);
                }),
              ]);
            } catch { client.destroy(); }
            finally { clearTimeout(timer); }
          }
          client.off('error', onError);
        });
      }
      return closePromise;
    },
    forceClose,
  };
}

module.exports = {createSessionLifecycle};
