'use strict';

const {expect} = require('chai');
const {spawnSync} = require('child_process');
const path = require('path');
const fixture = require('../../fixtures/verify/contour_timings.json');
const {deriveContourDeadlines} = require('../../../lib/verify/contour_deadlines');

describe('measured browser and MySQL deadlines', () => {
  it('uses all fifteen actual stage durations with the existing twofold margin', () => {
    expect(deriveContourDeadlines(fixture)).to.deep.equal({browser: 631588, mysql: 282776});
    expect(deriveContourDeadlines(fixture).browser).to.be.lessThan(1800000);
    expect(deriveContourDeadlines(fixture).mysql).to.be.lessThan(300000);
  });

  it('preserves failed Core workflows while using their successful MySQL jobs', () => {
    expect(fixture.samples.filter(sample => sample.stageId === 'mysql-dialect' && sample.runConclusion === 'failure')).to.have.lengthOf(2);
    expect(() => deriveContourDeadlines(fixture)).not.to.throw();
  });

  for (const [name, mutate] of [
    ['missing calibration', data => { delete data.samples; }],
    ['missing sample', data => data.samples.pop()],
    ['unapproved margin', data => { data.margin = 3; }],
    ['extra top-level data', data => { data.environment = {}; }],
    ['unrelated branch', data => { data.branch = 'master'; }],
    ['wrong workflow', data => { data.samples[0].workflow = 'core-ci.yml'; }],
    ['wrong job', data => { data.samples[0].jobName = 'Browser suite 2/4'; }],
    ['failed job', data => { data.samples[0].jobConclusion = 'failure'; }],
    ['failed browser workflow', data => { data.samples[0].runConclusion = 'failure'; }],
    ['retry', data => { data.samples[0].attempt = 2; }],
    ['dirty source', data => { data.samples[0].sourceClean = false; }],
    ['inconsistent SHA', data => { data.samples[0].headSha = '0'.repeat(40); }],
    ['duplicate job ID', data => { data.samples[0].jobId = data.samples[1].jobId; }],
    ['duplicate stage', data => { data.samples[0] = {...data.samples[1]}; }],
    ['zero duration', data => { data.samples[0].durationMs = 0; }],
    ['nonfinite duration', data => { data.samples[0].durationMs = Infinity; }],
    ['duration beyond job', data => { data.samples[0].durationMs = 1800000; }],
    ['captured before completion', data => { data.capturedAt = '2026-01-01T00:00:00Z'; }],
    ['malformed date', data => { data.samples[0].startedAt = 'yesterday'; }],
    ['synthetic fixture path', data => { data.samples[0].artifact = data.samples[0].artifact.replace('verify-browser-shard-1', 'evidence-test-fake'); }],
    ['mismatched invocation', data => { data.samples[0].invocationId = data.samples[1].invocationId; }],
    ['missing file hash', data => { delete data.samples[0].summarySha256; }],
    ['extra opaque data', data => { data.samples[0].environment = 'not allowed'; }],
    ['ambiguous run grouping', data => { data.samples[0].runId = data.samples[5].runId; }],
  ]) {
    it(`rejects ${name}`, () => {
      const data = structuredClone(fixture);
      mutate(data);
      expect(() => deriveContourDeadlines(data)).to.throw('Invalid contour timing provenance');
    });
  }

  it('enforces calibration when loading the real registry, not just in tests', () => {
    const run = spawnSync(process.execPath, ['-e', `
      require('./t/fixtures/verify/contour_timings.json').samples[0].attempt = 2;
      require('./lib/verify/stages');
    `], {cwd: path.resolve(__dirname, '../../..'), timeout: 5000, encoding: 'utf8'});
    expect(run.status).to.equal(1);
    expect(run.stderr).to.include('Invalid contour timing provenance');
  });
});
