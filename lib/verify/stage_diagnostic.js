'use strict';

const fs = require('fs');
const crypto = require('crypto');
const {isDeepStrictEqual} = require('util');
const redact = require('./diagnostic_text');

const MAX_BYTES = 16384;
const events = ['test-start', 'test-pass', 'test-fail', 'test-retry', 'hook-start', 'hook-end', 'end'];
const keysEqual = (value, keys) => value && isDeepStrictEqual(Object.keys(value).sort(), keys.slice().sort());
const version = value => typeof value === 'string' && /^\d+(?:\.\d+){1,3}$/.test(value) ? value : null;
let browserVersion = null;
let driverVersion = null;
let onRuntime = null;

// Selenium returns cached session capabilities; no second browser command or
// version subprocess is needed. Never persist capability URLs/profile paths.
function recordCapabilities(capabilities) {
  browserVersion = capabilities ? version(capabilities.get('browserVersion')) : null;
  driverVersion = capabilities ? version(String(capabilities.get('chrome')?.chromedriverVersion || '').split(' ')[0]) : null;
  if (onRuntime) { onRuntime(); }
}

function featureFlags(env) {
  const choices = {
    LEAVEPILOT_FEATURES: ['all'],
    LEAVEPILOT_EDITION: ['community', 'commercial'],
    TEST_ENFORCE_SKIP_HONESTY: ['true', 'false'],
    TEST_TRACE_FORMS: ['1', '0', 'true', 'false'],
  };
  return Object.fromEntries(Object.entries(choices).map(([key, allowed]) => [
    key, env[key] === undefined ? null : allowed.includes(env[key]) ? env[key] : 'unavailable',
  ]));
}

function createWriter(env = process.env) {
  const prefix = env.TEST_VERIFY_DIAGNOSTIC_PREFIX;
  const identity = env.TEST_VERIFY_DIAGNOSTIC_ID;
  // Unit specs spawn their own Mocha fixtures. They must not inherit permission
  // to replace this parent runner's evidence. Each outer verify sets a new ID.
  delete env.TEST_VERIFY_DIAGNOSTIC_PREFIX;
  delete env.TEST_VERIFY_DIAGNOSTIC_ID;
  if (!prefix || !identity) { return () => {}; }
  const flags = featureFlags(env);
  const dbContour = env.DB_DIALECT === 'mysql' ? 'mysql' : 'sqlite';
  let last = null;
  const write = payload => {
    const snapshot = {...payload, version: 1, identity,
      runtime: {nodeVersion: process.version, browserVersion, driverVersion, dbContour, featureFlags: flags}};
    const text = JSON.stringify(snapshot) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) { throw new Error('Stage diagnostic exceeds size limit'); }
    const temporary = `${prefix}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, text, {mode: 0o600, flag: 'wx'});
    fs.renameSync(temporary, `${prefix}.latest.json`);
    if (['test-fail', 'test-retry'].includes(snapshot.event)) {
      try { fs.writeFileSync(`${prefix}.first-failure.json`, text, {mode: 0o600, flag: 'wx'}); }
      catch (error) { if (error.code !== 'EEXIST') { throw error; } }
    }
  };
  onRuntime = () => { if (last) { write(last); } };
  return payload => { last = payload; write(payload); };
}

const safeText = value => typeof value === 'string' && value.length <= 2048 && redact(value) === value;
const validTest = value => value === null || (keysEqual(value, ['title', 'spec']) && safeText(value.title)
  && (value.spec === null || (safeText(value.spec) && /^t\/[a-zA-Z0-9_./-]+\.js$/.test(value.spec) && !value.spec.split('/').includes('..'))));

function validSnapshot(value, identity) {
  if (!keysEqual(value, ['version', 'identity', 'event', 'currentTest', 'lastCompletedTest', 'failure', 'runtime'])
    || value.version !== 1 || value.identity !== identity || !events.includes(value.event)
    || !validTest(value.currentTest) || !validTest(value.lastCompletedTest)
    || !(value.failure === null || (keysEqual(value.failure, ['name', 'message']) && safeText(value.failure.name) && safeText(value.failure.message)))) { return false; }
  const runtime = value.runtime;
  return keysEqual(runtime, ['nodeVersion', 'browserVersion', 'driverVersion', 'dbContour', 'featureFlags'])
    && /^v22\.\d+\.\d+$/.test(runtime.nodeVersion)
    && [runtime.browserVersion, runtime.driverVersion].every(item => item === null || version(item) === item)
    && ['sqlite', 'mysql'].includes(runtime.dbContour)
    && isDeepStrictEqual(featureFlags(Object.fromEntries(Object.entries(runtime.featureFlags || {}).filter(([, item]) => item !== null))), runtime.featureFlags);
}

function readSnapshot(file, identity) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) { throw new Error('Invalid sidecar'); }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_BYTES) { throw new Error('Oversized sidecar'); }
    const snapshot = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!validSnapshot(snapshot, identity)) { throw new Error('Invalid sidecar'); }
    return {state: 'received', snapshot};
  } catch (error) {
    return {state: error.code === 'ENOENT' ? 'unavailable' : 'invalid'};
  } finally { if (fd !== undefined) { fs.closeSync(fd); } }
}

function readDiagnostics(prefix, identity) {
  return {latest: readSnapshot(`${prefix}.latest.json`, identity), firstFailure: readSnapshot(`${prefix}.first-failure.json`, identity)};
}

module.exports = {createWriter, recordCapabilities, featureFlags, readDiagnostics, validSnapshot};
