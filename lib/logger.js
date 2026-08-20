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

const env = process.env.NODE_ENV || 'development';
const configured = (process.env.LOG_LEVEL || '').toLowerCase();
const defaultLevel = env === 'production' ? 'info' : 'debug';
const maxLevel = LEVELS[configured] !== undefined ? LEVELS[configured] : LEVELS[defaultLevel];

function emit(level, message, meta) {
  if (LEVELS[level] > maxLevel) return;

  const entry = {
    time: new Date().toISOString(),
    level,
    msg: message,
  };

  if (meta && typeof meta === 'object') {
    Object.assign(entry, meta);
  }

  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  error: (msg, meta) => emit('error', msg, meta),
  warn:  (msg, meta) => emit('warn',  msg, meta),
  info:  (msg, meta) => emit('info',  msg, meta),
  debug: (msg, meta) => emit('debug', msg, meta),
};
