'use strict';

const logger = require('./middleware/request_logger');

function createShutdownCoordinator(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 10000;
  let shuttingDown = false;

  return function shutdown(reason, error, exitCode) {
    if (shuttingDown) {return Promise.resolve(false);}
    shuttingDown = true;
    const code = exitCode === undefined ? 1 : exitCode;
    const log = code === 0 ? logger.info : logger.error;
    log(reason, error ? { error } : {});

    const closeTasks = [];
    if (opts.server && typeof opts.server.close === 'function') {
      closeTasks.push(new Promise(resolve => opts.server.close(() => resolve())));
    }
    if (opts.db && typeof opts.db.close === 'function') {
      closeTasks.push(Promise.resolve().then(() => opts.db.close()));
    }

    return Promise.race([
      Promise.allSettled(closeTasks),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]).finally(() => opts.exit(code)).then(() => true);
  };
}

function installProcessHandlers(options) {
  const shutdown = createShutdownCoordinator(Object.assign({ exit: code => { process.exitCode = code; } }, options));
  process.once('uncaughtException', error => { shutdown('uncaught_exception', error, 1); });
  process.once('unhandledRejection', error => { shutdown('unhandled_rejection', error, 1); });
  process.once('SIGTERM', () => { shutdown('sigterm', null, 0); });
  process.once('SIGINT', () => { shutdown('sigint', null, 0); });
  return shutdown;
}

module.exports = { createShutdownCoordinator, installProcessHandlers };
