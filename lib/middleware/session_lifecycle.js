'use strict';

const {randomBytes} = require('node:crypto');

const RECOVERY_TIMEOUT_MS = 20000;
const safeCode = error => error && typeof error.code === 'string'
  && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined;

function storeCall(store, method, ...args) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const callback = (error, result) => {
      if (finished) { return; }
      finished = true;
      if (error) { reject(error); }
      else { resolve(result); }
    };
    try {
      const returned = store[method](...args, callback);
      if (returned && typeof returned.catch === 'function') {
        returned.catch(callback);
      }
    } catch (error) { callback(error); }
  });
}

async function probeStore(store) {
  const sid = randomBytes(18).toString('hex');
  const payload = {
    cookie: {expires: new Date(Date.now() + 5000).toISOString()},
    marker: randomBytes(18).toString('hex'),
  };
  try {
    await storeCall(store, 'set', sid, payload);
    const stored = await storeCall(store, 'get', sid);
    if (JSON.stringify(stored) !== JSON.stringify(payload)) {
      throw new Error('session_probe_mismatch');
    }
    await storeCall(store, 'touch', sid, payload);
    await storeCall(store, 'destroy', sid);
  } finally {
    // Destroying twice is safe and also covers partial writes. Never expose
    // the synthetic SID or payload through logs or lifecycle events.
    try { await storeCall(store, 'destroy', sid); }
    catch { /* The outage deadline still owns failure. */ }
  }
}

function createSessionLifecycle({store, client, recoveryTimeoutMs = RECOVERY_TIMEOUT_MS, logger}) {
  if (!Number.isFinite(recoveryTimeoutMs) || recoveryTimeoutMs <= 0) {
    throw new Error('recoveryTimeoutMs must be a finite positive number');
  }
  let state = 'created';
  let initializePromise;
  let closePromise;
  let recoveryTimer;
  let probePromise;
  const listeners = new Set();
  const notify = (nextState, error) => {
    if (state === 'closed' || state === 'failed') { return; }
    state = nextState;
    for (const listener of listeners) { listener({state: nextState, error}); }
  };
  const onError = error => {
    logger.error('redis_session_transport_error', {code: safeCode(error)});
    if (state !== 'ready') { return; }
    notify('unready');
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      notify('failed', new Error('session_recovery_deadline'));
    }, recoveryTimeoutMs);
  };
  const verifyRecovery = () => {
    if (state !== 'unready' || probePromise) { return; }
    probePromise = probeStore(store).then(() => {
      if (state !== 'unready') { return; }
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
      notify('ready');
    }, error => {
      logger.warn('redis_session_probe_failed', {code: safeCode(error)});
    }).finally(() => { probePromise = null; });
  };
  const onReady = () => { verifyRecovery(); };
  client.on('error', onError);
  client.on('ready', onReady);

  return {
    initialize() {
      if (state === 'closed') { return Promise.reject(new Error('Session store is closed')); }
      if (!initializePromise) {
        initializePromise = Promise.resolve().then(() => client.connect()).then(() => probeStore(store))
          .then(() => { if (state === 'created') { notify('ready'); } }, error => {
            initializePromise = null;
            throw error;
          });
      }
      return initializePromise;
    },
    isReady: () => state === 'ready',
    reportFailure: error => notify('failed', error),
    onStateChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      if (!closePromise) {
        state = 'closed';
        clearTimeout(recoveryTimer);
        client.off('error', onError);
        client.off('ready', onReady);
        listeners.clear();
        closePromise = client.isOpen ? client.close() : Promise.resolve();
      }
      return closePromise;
    },
    forceClose() {
      state = 'closed';
      clearTimeout(recoveryTimer);
      client.destroy();
      return Promise.resolve();
    },
  };
}

module.exports = {createSessionLifecycle};
