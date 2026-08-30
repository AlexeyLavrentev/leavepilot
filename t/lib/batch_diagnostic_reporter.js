'use strict';

const fs = require('fs');
const path = require('path');
const FlakeReporter = require('./flake_reporter');

const MAX_TEXT_BYTES = 2048;
const MAX_SNAPSHOT_BYTES = 8192;

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

module.exports = class BatchDiagnosticReporter extends FlakeReporter {
  constructor(runner, options) {
    super(runner, options);

    const reporterOption = options && options.reporterOption || {};
    const snapshotPath = process.env.TEST_BATCH_DIAGNOSTIC_PATH;
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
