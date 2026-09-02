'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {expect} = require('chai');
const reporter = require('../../../t/lib/flake_reporter');

describe('verification attempt honesty', () => {
  it('writes immutable attempt evidence and rejects overwriting it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leavepilot-attempt-'));
    const target = path.join(directory, 'attempt-1.json');
    reporter.writeAttemptEvidence(target, {attempt: 1, status: 'failed'});
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).to.deep.equal({attempt: 1, status: 'failed'});
    expect(() => reporter.writeAttemptEvidence(target, {attempt: 1, status: 'passed'})).to.throw('immutable');
  });

  it('keeps first-pass failure red even when the diagnostic rerun passes', () => {
    expect(reporter.aggregateAttempts([
      {number: 1, status: 'failed'},
      {number: 2, status: 'passed'},
    ])).to.deep.include({status: 'failed', flakeCandidate: true});
  });
});
