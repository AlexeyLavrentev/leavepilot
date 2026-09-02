'use strict';

/*
  Thin structured logger.  Wraps console with level filtering so that
  production logs can suppress debug noise while development keeps it.

  Levels: error > warn > info > debug

  Set LOG_LEVEL env to control verbosity (default: "info" in production,
  "debug" elsewhere).

  Usage:
    const log = require('./logger');
    log.info('server started', { port: 3000 });
    log.error('db connection failed', { err: error.message });
*/

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const requestLogger = require('./middleware/request_logger');

const env = process.env.NODE_ENV || 'development';
const configured = (process.env.LOG_LEVEL || '').toLowerCase();
const defaultLevel = env === 'production' ? 'info' : 'debug';
const maxLevel = LEVELS[configured] !== undefined ? LEVELS[configured] : LEVELS[defaultLevel];

function emit(level, message, meta) {
  if (LEVELS[level] > maxLevel) {return;}

  try {
    const line = requestLogger._format(level, message, meta);

    if (level === 'error') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else if (level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  } catch {
    // Logging must never crash the application, even if a stream is unavailable.
  }
}

module.exports = {
  error: (msg, meta) => emit('error', msg, meta),
  warn:  (msg, meta) => emit('warn',  msg, meta),
  info:  (msg, meta) => emit('info',  msg, meta),
  debug: (msg, meta) => emit('debug', msg, meta),
};
