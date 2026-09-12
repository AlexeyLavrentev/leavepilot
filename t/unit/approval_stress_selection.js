'use strict';

const {expect} = require('chai');
const fs = require('fs');
const crypto = require('crypto');
const {selectIterations, validateObservation} = require('../../scripts/measure_approval_stress');

describe('measured approval stress selection', () => {
  it('keeps the committed actual-flow measurements tied to unchanged measured files', () => {
    const fixture = require('../fixtures/verify/approval_stress.json');
    expect(fixture.iterationCount).to.equal(selectIterations(fixture.calibrationMs));
    expect(fixture.stressMs).to.have.length(fixture.iterationCount);
    expect(fixture.stressDurationMs).to.equal(fixture.stressMs.reduce((sum, value) => sum + value, 0));
    expect(fixture.stressDurationMs).to.be.at.most(fixture.budgetMs);
    expect(fixture.reproduction).to.include({retries: 0, dbContour: 'sqlite', featureFlags: 'all', headless: true});
    expect(fixture.checksPerRun).to.equal(22);
    for (const [file, hash] of Object.entries(fixture.measuredFiles)) {
      expect(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), file).to.equal(hash);
    }
  });

  it('uses the slowest independent sample within the recorded budget', () => {
    expect(selectIterations([4000, 6000, 5000])).to.equal(5);
    expect(selectIterations([10000, 12000, 11000])).to.equal(2);
    expect(selectIterations([1, 2, 3])).to.equal(25);
  });

  it('rejects missing, invalid or too-slow measurements instead of inventing a count', () => {
    for (const samples of [[], [100, 200], [1, NaN, 2], [1, 0, 2], [1, -1, 2], [10000, 30001, 10000]]) {
      expect(() => selectIterations(samples)).to.throw();
    }
  });

  it('requires both decision steps and the complete first-attempt result', () => {
    const valid = {tests: 22, passes: 22, failures: 0, pending: 0, retries: 0, approvalActionPassed: true, employeeCalendarCheckPassed: true};
    expect(() => validateObservation(valid)).not.to.throw();
    for (const [key, value] of [['tests', 0], ['passes', 21], ['failures', 1], ['pending', 1], ['retries', 1], ['approvalActionPassed', false], ['employeeCalendarCheckPassed', false]]) {
      expect(() => validateObservation({...valid, [key]: value})).to.throw();
    }
  });
});
