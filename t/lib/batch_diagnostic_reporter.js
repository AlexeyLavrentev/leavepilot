'use strict';

const fs = require('fs');
const path = require('path');
const FlakeReporter = require('./flake_reporter');

const MAX_TEXT_BYTES = 2048;
const MAX_SNAPSHOT_BYTES = 8192;
const MAX_SUBMIT_DIAGNOSTIC_BYTES = 4096;

const redact = value => String(value || '')
  .replace(/\b(authorization|cookie|password|secret|token|api[_-]?key|key)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, '$1=[REDACTED]')
  .slice(-MAX_TEXT_BYTES);

const compactError = error => {
  if (!error) {
    return null;
  }
  return {
    name: redact(error.name || 'Error'),
    message: redact(error.message || error),
  };
};

const relativeSpec = file => {
  if (!file) {
    return null;
  }
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') ? relative : null;
};

const writeSnapshot = (snapshotPath, payload) => {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) {
    throw new Error('batch diagnostic snapshot exceeds size limit');
  }
  const temporary = `${snapshotPath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(snapshotPath), {recursive: true});
  fs.writeFileSync(temporary, serialized + '\n', {mode: 0o600});
  fs.renameSync(temporary, snapshotPath);
};

const safeSubmitStage = stage => [
  'before-click', 'after-click', 'navigation-observation', 'modal-observation', 'helper-rejection',
].includes(stage);

const hasOnlyKeys = (value, keys) => value && typeof value === 'object'
  && Object.keys(value).every(key => keys.includes(key))
  && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

const validInvalidControl = control => control && typeof control === 'object'
  && ['input', 'select', 'textarea', 'unreadable'].includes(control.tag)
  && (control.type === 'unreadable' || /^[a-z][a-z0-9_-]{0,31}$/.test(control.type))
  && (control.name === 'unreadable' || (/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(control.name)
    && !/(authorization|cookie|password|secret|token|api[_-]?key|key)/i.test(control.name)))
  && hasOnlyKeys(control, ['tag', 'type', 'name']);

const validSubmitDiagnosticState = (state, historyEntry = false) => {
  const expectedKeys = [
    'stage', 'url', 'timeOrigin', 'readyState', 'rootStatus', 'modal', 'submit', 'events',
  ].concat(historyEntry ? [] : ['beforeClickHistory']);
  const modal = state && state.modal;
  const submit = state && state.submit;
  const events = state && state.events;
  if (!hasOnlyKeys(state, expectedKeys)
    || !safeSubmitStage(state.stage)
    || (historyEntry && state.stage !== 'before-click')
    || typeof state.url !== 'string' || /[?#]/.test(state.url)
    || !(state.timeOrigin === null || Number.isFinite(state.timeOrigin))
    || !['loading', 'interactive', 'complete', 'unreadable'].includes(state.readyState)
    || !['absent', 'unreadable', 'alive', 'stale', 'unobserved'].includes(state.rootStatus)
    || !hasOnlyKeys(modal, ['presence', 'visible', 'classTokens'])
    || !(typeof modal.presence === 'boolean' || modal.presence === 'unreadable')
    || !(typeof modal.visible === 'boolean' || modal.visible === 'unreadable')
    || !Array.isArray(modal.classTokens) || modal.classTokens.length > 12
    || !modal.classTokens.every(token => typeof token === 'string'
      && /^[a-zA-Z0-9_-]{1,48}$/.test(token)
      && !/(authorization|cookie|password|secret|token|api[_-]?key|key)/i.test(token))
    || !hasOnlyKeys(submit, [
      'presence', 'disabled', 'connected', 'formAction', 'inModal', 'tag', 'type', 'formPresent',
      'formOwnership', 'formValid', 'invalidControl',
    ])
    || !(typeof submit.presence === 'boolean' || submit.presence === 'unreadable')
    || !(typeof submit.disabled === 'boolean' || submit.disabled === 'unreadable')
    || !(typeof submit.connected === 'boolean' || submit.connected === 'unreadable')
    || !(submit.formAction === 'unreadable' || /^\/[A-Za-z0-9._~!$&'()*+,;=:@/%-]{0,511}$/.test(submit.formAction))
    || !(typeof submit.inModal === 'boolean' || submit.inModal === 'unreadable')
    || !['button', 'input', 'unreadable'].includes(submit.tag)
    || !(submit.type === 'unreadable' || /^[a-z][a-z0-9_-]{0,31}$/.test(submit.type))
    || !(typeof submit.formPresent === 'boolean' || submit.formPresent === 'unreadable')
    || !['ancestor', 'external', 'none', 'unreadable'].includes(submit.formOwnership)
    || !(typeof submit.formValid === 'boolean' || submit.formValid === 'unreadable')
    || (submit.formValid !== false
      ? submit.invalidControl !== null
      : !validInvalidControl(submit.invalidControl))
    || !hasOnlyKeys(events, ['submit', 'beforeunload'])
    || !Number.isSafeInteger(events.submit) || events.submit < 0
    || !Number.isSafeInteger(events.beforeunload) || events.beforeunload < 0) {
    return false;
  }
  if (historyEntry) {
    return true;
  }
  return Array.isArray(state.beforeClickHistory)
    && state.beforeClickHistory.length <= 4
    && state.beforeClickHistory.every(entry => validSubmitDiagnosticState(entry, true));
};

const submitDiagnostic = (snapshotPath, identity, failure) => {
  if (!snapshotPath) {
    return {state: 'absent'};
  }
  if (failure && failure.name === 'SubmitDiagnosticError') {
    return {state: 'write-failed'};
  }
  let payload;
  try {
    const text = fs.readFileSync(snapshotPath, 'utf8');
    if (Buffer.byteLength(text) > MAX_SUBMIT_DIAGNOSTIC_BYTES) {
      throw new Error('submit diagnostic exceeds size limit');
    }
    payload = JSON.parse(text);
    const state = payload && payload.state;
    if (!payload || payload.version !== 1 || !state
      || payload.identity.runId !== identity.runId
      || payload.identity.batchId !== identity.batchId
      || payload.identity.spec !== identity.spec
      || !validSubmitDiagnosticState(state)) {
      throw new Error('submit diagnostic identity or schema mismatch');
    }
    return {state: 'received', snapshot: state};
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {state: 'absent'};
    }
    return {state: 'invalid', reason: redact(error.message)};
  }
};

module.exports = class BatchDiagnosticReporter extends FlakeReporter {
  constructor(runner, options) {
    super(runner, options);

    const reporterOption = options && options.reporterOption || {};
    const snapshotPath = process.env.TEST_BATCH_DIAGNOSTIC_PATH;
    const submitDiagnosticPath = process.env.TEST_SUBMIT_DIAGNOSTIC_PATH;
    const identity = {
      runId: reporterOption.runId || null,
      batchId: reporterOption.batchId || null,
      spec: reporterOption.spec || null,
    };
    let currentTest = null;
    let lastCompletedTest = null;
    let failure = null;

    const snapshot = event => {
      if (!snapshotPath) {
        return;
      }
      const payload = {
        version: 1,
        identity,
        event,
        currentTest,
        lastCompletedTest,
        failure,
        submitDiagnostic: submitDiagnostic(submitDiagnosticPath, identity, failure),
        updatedAt: new Date().toISOString(),
      };
      try {
        writeSnapshot(snapshotPath, payload);
      } catch (error) {
        console.error(`batch diagnostic reporter: ${redact(error.message)}`);
      }
    };

    runner.on('test', test => {
      currentTest = {title: redact(test.fullTitle()), spec: relativeSpec(test.file) || identity.spec};
      snapshot('test-start');
    });
    runner.on('pass', test => {
      lastCompletedTest = {title: redact(test.fullTitle()), spec: relativeSpec(test.file) || identity.spec};
      currentTest = null;
      snapshot('test-pass');
    });
    runner.on('fail', (test, error) => {
      currentTest = {title: redact(test.fullTitle()), spec: relativeSpec(test.file) || identity.spec};
      failure = compactError(error);
      snapshot('test-fail');
    });
    runner.once('end', () => snapshot('end'));
  }
};

module.exports._redact = redact;
module.exports._writeSnapshot = writeSnapshot;
module.exports._submitDiagnostic = submitDiagnostic;
module.exports._validSubmitDiagnosticState = validSubmitDiagnosticState;
