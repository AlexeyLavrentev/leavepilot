'use strict';

const logger = require('./middleware/request_logger');

function safeErrorDetails(error) {
  if (!error) { return undefined; }
  const cause = error.parent || error.original || error.cause;
  return {
    name: error.name || 'Error',
    code: error.code || (cause && cause.code) || undefined,
    stage: error.startupStage || undefined,
  };
}

function createShutdownCoordinator(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 10000;
  let shuttingDown = false;

  return function shutdown(reason, error, exitCode) {
    if (shuttingDown) {return Promise.resolve(false);}
    shuttingDown = true;
    if (opts.onTerminalStart) { opts.onTerminalStart(); }
    const code = exitCode === undefined ? 1 : exitCode;
    const log = code === 0 ? logger.info : logger.error;
    const diagnostic = reason === 'startup_failed' || reason === 'session_store_failed'
      ? safeErrorDetails(error)
      : error;
    log(reason, error ? {error: diagnostic} : {});

    const server = opts.getServer ? opts.getServer() : opts.server;
    const lifecycle = opts.getSessionLifecycle ? opts.getSessionLifecycle() : opts.sessionLifecycle;
    const db = opts.getDb ? opts.getDb() : opts.db;
    const closeInOrder = async () => {
      if (server && typeof server.close === 'function') {
        await new Promise(resolve => server.close(() => resolve()));
      }
      if (lifecycle && typeof lifecycle.close === 'function') {
        await lifecycle.close();
      }
      if (db && typeof db.close === 'function') {
        await db.close();
      }
    };

    let deadline;
    return Promise.race([
      closeInOrder().catch(closeError => logger.error('shutdown_close_failed', {error: safeErrorDetails(closeError)})),
      new Promise(resolve => { deadline = setTimeout(resolve, timeoutMs); }),
    ]).finally(() => {
      clearTimeout(deadline);
      opts.exit(code);
    }).then(() => true);
  };
}

function installProcessHandlers(options) {
  const shutdown = options.shutdown || createShutdownCoordinator(Object.assign({ exit: code => { process.exitCode = code; } }, options));
  process.once('uncaughtException', error => { shutdown('uncaught_exception', error, 1); });
  process.once('unhandledRejection', error => { shutdown('unhandled_rejection', error, 1); });
  process.once('SIGTERM', () => { shutdown('sigterm', null, 0); });
  process.once('SIGINT', () => { shutdown('sigint', null, 0); });
  return shutdown;
}

module.exports = { createShutdownCoordinator, installProcessHandlers };
