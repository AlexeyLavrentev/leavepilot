'use strict';

const serverListener = require('./server_listener');
const runtimeShutdown = require('./runtime_shutdown');

function startRuntime(options = {}) {
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
  let db;
  let lifecycle;
  let unsubscribe;
  let startPromise;
  let stopPromise;
  let stopping = false;
  let startupDeadline;

  const terminal = runtimeShutdown.createShutdownCoordinator({
    getServer: () => server,
    getSessionLifecycle: () => lifecycle,
    getDb: () => db && db.sequelize,
    timeoutMs: options.shutdownTimeoutMs || 10000,
    onTerminalStart: () => {
      stopping = true;
      clearTimeout(startupDeadline);
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
    exit,
  });

  function shutdown(reason, error, code) {
    if (stopPromise) {
      return Promise.resolve(false);
    }
    stopPromise = terminal(reason, error, code);
    return stopPromise;
  }

  function start() {
    if (startPromise) {
      return startPromise;
    }
    // Fatal and signal ownership must exist before app composition can throw.
    installHandlers(shutdown);
    startupDeadline = setTimeout(() => {
      if (!stopping) {
        shutdown('startup_failed', new Error('startup_deadline'), 1);
      }
    }, options.startupTimeoutMs || 30000);
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
        await db.connect();
        if (stopping) { return undefined; }
        await lifecycle.initialize();
        if (stopping) { return undefined; }
        const listening = await listen({app, port: app.get('port'), host: app.get('host')});
        server = listening;
        if (stopping) {
          await new Promise(resolve => listening.close(resolve));
          return undefined;
        }
        startSchedulers({app, models: db});
        if (stopping) { return undefined; }
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

  return {start, shutdown, whenStopped: () => stopPromise || Promise.resolve(false)};
}

module.exports = {startRuntime};
