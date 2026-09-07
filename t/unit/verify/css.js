'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

describe('CSS verification CLI', function() {
  this.timeout(10000);

  const cases = [
    {name: 'accepts a successful build and diff', build: 'exit 0', diff: 'exit 0', code: 0},
    {name: 'rejects CSS drift', build: 'exit 0', diff: 'exit 1', code: 1},
    {name: 'preserves a git error status', build: 'exit 0', diff: 'exit 128', code: 128},
    {name: 'rejects missing git', build: 'exit 0', code: 1},
    {name: 'rejects a signalled git process', build: 'exit 0', diff: 'kill -TERM $$', code: 1},
    {name: 'stops before diff when the build fails', build: 'exit 7', diff: 'exit 0', code: 7, noDiff: true},
    {name: 'stops before diff when npm is missing', diff: 'exit 0', code: 1, noDiff: true},
    {name: 'stops before diff when the build is signalled', build: 'kill -TERM $$', diff: 'exit 0', code: 1, noDiff: true},
  ];

  for (const testCase of cases) {
    it(testCase.name, function() {
      if (process.platform === 'win32') { return this.skip(); }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-css-'));
      try {
        if (testCase.build) {
          fs.writeFileSync(path.join(directory, 'npm'), `#!/bin/sh\n${testCase.build}\n`, {mode: 0o700});
        }
        if (testCase.diff) {
          fs.writeFileSync(path.join(directory, 'git'), `#!/bin/sh\n: > diff-ran\n${testCase.diff}\n`, {mode: 0o700});
        }
        const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../../bin/verify_css.js')], {
          cwd: directory,
          env: {...process.env, PATH: directory},
          encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, testCase.code, result.stderr);
        if (testCase.noDiff) { assert.equal(fs.existsSync(path.join(directory, 'diff-ran')), false); }
      } finally {
        fs.rmSync(directory, {recursive: true, force: true});
      }
    });
  }
});
