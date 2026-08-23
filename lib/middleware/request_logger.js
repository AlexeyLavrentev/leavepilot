'use strict';

const requestContext = require('./request_context');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED_KEYS = new Set(['time', 'level', 'msg', 'event', 'requestId']);
const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|signature|token|private.?key|public.?key|session|credential|raw)/i;
const REDACTED = '[REDACTED]';
let currentLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function shouldLog(level) {
  return LEVELS[level] !== undefined && LEVELS[level] >= currentLevel;
}

function sanitize(value, key, seen) {
  if (key && SENSITIVE_KEY.test(key)) {return REDACTED;}
  if (value === undefined) {return undefined;}
  if (typeof value === 'bigint') {return value.toString();}
  if (typeof value === 'function' || typeof value === 'symbol') {return String(value);}
  if (!value || typeof value !== 'object') {return value;}

  const visited = seen || new WeakSet();
  if (visited.has(value)) {return '[Circular]';}
  visited.add(value);

  if (value instanceof Error) {
    return sanitize({
      name: value.name,
      message: value.message,
      code: value.code,
      stack: value.stack,
    }, key, visited);
  }

  if (Array.isArray(value)) {return value.map(item => sanitize(item, '', visited));}

  return Object.keys(value).reduce((result, childKey) => {
    const sanitized = sanitize(value[childKey], childKey, visited);
    if (sanitized !== undefined) {result[childKey] = sanitized;}
    return result;
  }, {});
}

function format(level, event, meta, baseMeta) {
  const context = requestContext.get();
  const entry = {
    time: new Date().toISOString(),
    level,
    msg: typeof event === 'string' ? event : String(event),
    event: typeof event === 'string' ? event : String(event),
  };
  const boundRequestId = context.requestId
    || (baseMeta && baseMeta.requestId)
    || (meta && meta.requestId);
  if (boundRequestId) {entry.requestId = boundRequestId;}

  [baseMeta, meta].forEach(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {return;}
    Object.keys(source).forEach(key => {
      if (!RESERVED_KEYS.has(key)) {entry[key] = sanitize(source[key], key);}
    });
  });

  return JSON.stringify(entry);
}

function log(level, event, meta, baseMeta) {
  if (!shouldLog(level)) {return;}
  let line;
  try {
    line = format(level, event, meta, baseMeta);
  } catch (error) {
    line = JSON.stringify({
      time: new Date().toISOString(), level: 'error', msg: 'log_serialization_failed',
      event: 'log_serialization_failed', error: String(error && error.message || error),
    });
  }
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  try { stream.write(line + '\n'); } catch { /* logging must never crash the app */ }
}

function child(baseMeta) {
  return {
    debug: (event, meta) => log('debug', event, meta, baseMeta),
    info: (event, meta) => log('info', event, meta, baseMeta),
    warn: (event, meta) => log('warn', event, meta, baseMeta),
    error: (event, meta) => log('error', event, meta, baseMeta),
  };
}

module.exports = Object.assign(child(), {
  child,
  sanitize,
  _shouldLog: shouldLog,
  _format: format,
  _getLevel: () => currentLevel,
  _setLevel: value => { currentLevel = value; },
});
