'use strict';

const serverListener = require('./server_listener');
const runtimeShutdown = require('./runtime_shutdown');

const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

function isTransientStartupError(error) {
  const seen = new Set();
  const pending = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (TRANSIENT_CODES.has(current.code)) {
      return true;
    }
    pending.push(current.parent, current.original, current.cause);
  }
  return false;
}

function startRuntime(options = {}) {
  const startupTimeoutMs = options.startupTimeoutMs === undefined ? 20000 : options.startupTimeoutMs;
  const retryDelayMs = options.retryDelayMs === undefined ? 250 : options.retryDelayMs;
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new Error('startupTimeoutMs must be a finite positive number');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error('retryDelayMs must be a finite positive number');
  }
  const loadApp = options.loadApp || (() => require('../app'));
  const listen = options.listen || serverListener.listen;
  const startSchedulers = options.startSchedulers || ((context) => require('./edition').startSchedulers(context));
  const installHandlers = options.installHandlers || (shutdown => runtimeShutdown.installProcessHandlers({shutdown}));
  const exit = options.exit || (code => process.exit(code));
  const sendReady = options.sendReady || (() => {
    if (typeof process.send === 'function') {
      process.send({type: 'test-server-ready'});
    }
  });
  let app;
  let server;
  const sockets = new Set();
  let schedulerHandles = [];
  let db;
  let lifecycle;
  let unsubscribe;
  let startPromise;
  let stopPromise;
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  let stopping = false;
  let startupDeadline;
  let cancelRetryWait;
  let deadlineAt;

  const terminal = runtimeShutdown.createShutdownCoordinator({
    getServer: () => server,
    getSockets: () => sockets,
    getSchedulers: () => schedulerHandles,
    getSessionLifecycle: () => lifecycle,
    getDb: () => db && db.sequelize,
    timeoutMs: options.shutdownTimeoutMs === undefined ? 10000 : options.shutdownTimeoutMs,
    onTerminalStart: () => {
      stopping = true;
      clearTimeout(startupDeadline);
      if (cancelRetryWait) {
        cancelRetryWait();
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
    exit,
  });

  function shutdown(reason, error, code) {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = terminal(reason, error, code);
    stopPromise.then(resolveStopped, resolveStopped);
    return stopPromise;
  }

  function waitBeforeRetry(delay) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, delay);
      cancelRetryWait = () => { clearTimeout(timer); resolve(); };
    });
  }

  async function runStartupStage(stage, operation) {
    let failures = 0;
    while (true) {
      if (stopping) {
        return;
      }
      if (Date.now() >= deadlineAt) {
        throw new Error('startup_deadline');
      }
      try {
        await operation();
        if (Date.now() >= deadlineAt) {
          throw new Error('startup_deadline');
        }
        return;
      } catch (error) {
        if (error && typeof error === 'object' && !error.startupStage) {
          error.startupStage = stage;
        }
        if (!isTransientStartupError(error) || Date.now() >= deadlineAt || stopping) {
          throw error;
        }
        const delay = Math.min(retryDelayMs * (2 ** Math.min(failures, 8)), 1000, deadlineAt - Date.now());
        failures += 1;
        if (delay <= 0) {
          throw error;
        }
        await waitBeforeRetry(delay);
        cancelRetryWait = null;
      }
    }
  }

  function start() {
    if (startPromise) {
      return startPromise;
    }
    // Fatal and signal ownership must exist before app composition can throw.
    installHandlers(shutdown);
    deadlineAt = Date.now() + startupTimeoutMs;
    startupDeadline = setTimeout(() => {
      if (!stopping) {
        shutdown('startup_failed', new Error('startup_deadline'), 1);
      }
    }, startupTimeoutMs);
    startPromise = (async () => {
      try {
        app = loadApp();
        app.set('port', process.env.PORT || 3000);
        app.set('host', process.env.HOST || undefined);
        db = app.get('db_model');
        const middleware = app.get('session_middleware');
        lifecycle = middleware && middleware.sessionLifecycle;
        if (!lifecycle) {
          throw new Error('Selected session lifecycle unavailable');
        }
        unsubscribe = lifecycle.onStateChange(({state, error}) => {
          if (state === 'failed' && !stopping) {
            shutdown('session_store_failed', error, 1);
          }
        });
        await runStartupStage('database', () => db.connect());
        if (stopping) { return undefined; }
        if (typeof db.assertSchemaReady === 'function') {
          await runStartupStage('schema', () => db.assertSchemaReady());
        }
        if (stopping) { return undefined; }
        await runStartupStage('session_store', () => lifecycle.initialize());
        if (stopping) { return undefined; }
        const listening = await listen({app, port: app.get('port'), host: app.get('host')});
        server = listening;
        if (typeof listening.on === 'function') {
          listening.on('connection', socket => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
            if (stopping) { socket.destroy(); }
          });
        }
        if (stopping) {
          await new Promise(resolve => listening.close(resolve));
          return undefined;
        }
        schedulerHandles = startSchedulers({app, models: db}) || [];
        if (stopping) { return undefined; }
        if (Date.now() >= deadlineAt) {
          throw new Error('startup_deadline');
        }
        sendReady();
        return server;
      } catch (error) {
        if (!stopping) {
          await shutdown('startup_failed', error, 1);
        }
        return undefined;
      } finally {
        clearTimeout(startupDeadline);
      }
    })();
    return startPromise;
  }

  return {start, shutdown, whenStopped: () => stopped};
}

module.exports = {startRuntime};
