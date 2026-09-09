'use strict';

const requestContext = require('./request_context');
const redactDiagnosticText = require('../util/diagnostic_text');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED_KEYS = new Set(['time', 'level', 'msg', 'event', 'requestId']);
const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|signature|token|private.?key|public.?key|api.?key|^key$|session|credential|raw)/i;
const REDACTED = '[REDACTED]';
const TRUNCATED = '[Truncated]';
// Diagnostic ceilings, not payload limits: keep normal records unchanged while
// bounding traversal, retained text and JSON escaping for untrusted metadata.
const MAX_DEPTH = 6;
const MAX_ITEMS = 32;
const MAX_STRING = 2048;
const MAX_RECORD_BYTES = 65536;
const budgetForRecord = () => ({nodes: 256, text: 8192});
let currentLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function shouldLog(level) {
  return LEVELS[level] !== undefined && LEVELS[level] >= currentLevel;
}

function safeText(value, budget, limit = MAX_STRING) {
  const text = String(value);
  const length = Math.min(limit, budget.text);
  const safe = redactDiagnosticText(text.slice(0, length));
  budget.text = Math.max(0, budget.text - safe.length);
  return safe + (text.length > length ? TRUNCATED : '');
}

function sanitize(value, key, seen = new WeakSet(), depth = 0, budget = budgetForRecord(), skipKeys) {
  if (budget.nodes-- <= 0 || budget.text <= 0) {return TRUNCATED;}
  if (key && SENSITIVE_KEY.test(key)) {return REDACTED;}
  if (value === undefined) {return undefined;}
  if (['string', 'bigint', 'function', 'symbol'].includes(typeof value)) {
    return safeText(value, budget);
  }
  if (!value || typeof value !== 'object') {return value;}

  const visited = seen;
  if (visited.has(value)) {return '[Circular]';}
  if (depth >= MAX_DEPTH) {return TRUNCATED;}
  visited.add(value);

  if (value instanceof Error) {
    return sanitize({
      name: value.name,
      message: value.message,
      code: value.code,
      stack: value.stack,
    }, key, visited, depth + 1, budget);
  }

  if (Array.isArray(value)) {
    const result = [];
    for (let i = 0; i < value.length; i++) {
      if (i >= MAX_ITEMS || budget.nodes <= 0 || budget.text <= 0) {
        result.push(TRUNCATED);
        break;
      }
      result.push(sanitize(value[i], '', visited, depth + 1, budget));
    }
    return result;
  }

  const result = Object.create(null);
  let count = 0;
  for (const childKey in value) {
    if (!Object.prototype.hasOwnProperty.call(value, childKey)) {continue;}
    if (count++ >= MAX_ITEMS || budget.nodes <= 0 || budget.text <= 0) {
      result[TRUNCATED] = true;
      break;
    }
    if (childKey.length > 256) {result[TRUNCATED] = true; continue;}
    if (skipKeys && skipKeys.has(childKey)) {continue;}
    const outputKey = safeText(childKey, budget, 256);
    const sanitized = sanitize(value[childKey], childKey, visited, depth + 1, budget);
    if (sanitized !== undefined) {result[outputKey] = sanitized;}
  }
  return result;
}

function format(level, event, meta, baseMeta) {
  const context = requestContext.get();
  const budget = budgetForRecord();
  const message = safeText(event, budget, 1024);
  const entry = {
    time: new Date().toISOString(),
    level,
    msg: message,
    event: message,
  };
  const boundRequestId = context.requestId
    || (baseMeta && baseMeta.requestId)
    || (meta && meta.requestId);
  if (boundRequestId) {entry.requestId = safeText(boundRequestId, budget, 256);}
  const baseEntry = {...entry};

  [baseMeta, meta].forEach(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {return;}
    const sanitized = sanitize(source, '', new WeakSet(), 0, budget, RESERVED_KEYS);
    if (sanitized === TRUNCATED) {entry[TRUNCATED] = true; return;}
    for (const key of Object.keys(sanitized)) {
      if (!RESERVED_KEYS.has(key)) {
        Object.defineProperty(entry, key, {value: sanitized[key], enumerable: true, configurable: true, writable: true});
      }
    }
  });

  const line = JSON.stringify(entry);
  return Buffer.byteLength(line) <= MAX_RECORD_BYTES
    ? line
    : JSON.stringify({...baseEntry, metadata: TRUNCATED});
}

function log(level, event, meta, baseMeta) {
  if (!shouldLog(level)) {return;}
  let line;
  try {
    line = format(level, event, meta, baseMeta);
  } catch {
    line = JSON.stringify({
      time: new Date().toISOString(), level: 'error', msg: 'log_serialization_failed',
      event: 'log_serialization_failed',
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
