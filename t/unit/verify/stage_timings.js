'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {expect} = require('chai');
const {validatePublicResult, validateCiCalibration} = require('../../../lib/verify/ci_calibration');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'verify',
  'stage_timings.json'
);

const readFixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

const expectIsoDate = value => {
  expect(value).to.be.a('string');
  expect(Number.isNaN(Date.parse(value)), value).to.equal(false);
};

const expectCommand = value => {
  expect(value).to.be.a('string').and.not.equal('');
  expect(value.startsWith('rtk '), value).to.equal(true);
};

const expectLocalStage = (name, stage) => {
  expectCommand(stage.command);
  expectIsoDate(stage.capturedAt);
  expect(stage.nodeVersion).to.match(/^v22\./);
  expect(stage.samples, `${name} needs repeated clean samples`).to.have.lengthOf.at.least(3);
  stage.samples.forEach(sample => {
    expect(sample.temperature).to.be.oneOf(['cold', 'warm']);
    expect(sample.durationMs).to.be.a('number').and.be.greaterThan(0);
  });

  const maximum = Math.max(...stage.samples.map(sample => sample.durationMs));
  expect(stage.observedMaximumMs).to.equal(maximum);
  const ciRuntimeFloors = stage.ciRuntimeFloors || [];
  ciRuntimeFloors.forEach(floor => {
    expect(floor.workflow).to.be.oneOf(['core-ci.yml', 'core-integration.yml']);
    expect(floor.runId).to.be.a('number').and.be.greaterThan(0);
    expect(floor.job).to.be.a('string').and.not.equal('');
    if (floor.workflow === 'core-integration.yml') {
      expect(floor.job).to.match(/^Browser suite [1-4]\/4$/);
    } else {
      expect(floor.job).to.equal('Core contract tests');
    }
    expect(floor.sourceUrl).to.match(
      /^https:\/\/github\.com\/AlexeyLavrentev\/leavepilot\/actions\/runs\//
    );
    expectIsoDate(floor.capturedAt);
    expect(floor.runner).to.equal('ubuntu-24.04');
    expect(floor.outcome).to.equal('timeout');
    expect(floor.lowerBoundMs).to.be.a('number').and.be.greaterThan(0);
  });
  const deadlineBasisMs = Math.max(
    maximum,
    ...ciRuntimeFloors.map(floor => floor.lowerBoundMs)
  );
  expect(stage.deadlineBasisMs || maximum).to.equal(deadlineBasisMs);
  expect(stage.margin).to.deep.include({kind: 'multiplier'});
  expect(stage.margin.value).to.be.a('number').and.be.greaterThan(1);
  expect(stage.deadlineMs).to.equal(Math.ceil(deadlineBasisMs * stage.margin.value));
};

const expectPublicResult = (name, result) => {
  validatePublicResult(name, result, readFixture().external.selection);
};

describe('stage timing evidence', function() {
  describe('local calibration', function() {
    it('includes fresh Linux SQLite databases and unchanged migration replays', function() {
      const stage = readFixture().local.sqliteMigration;
      expect(stage.platform).to.equal('linux');
      expect(stage.arch).to.equal('arm64');
      expect(stage.image).to.match(/^sha256:[a-f0-9]{64}$/);
      expect(stage.lockSha256).to.match(/^[a-f0-9]{64}$/);
      for (const sample of stage.samples) {
        expect(sample.freshDatabase).to.equal(true);
        expect(sample.replayUnchanged).to.equal(true);
        expect(sample.replayDurationMs).to.be.greaterThan(0);
        expect(sample.migrationCount).to.be.greaterThan(0);
      }
      expect(require('../../../lib/verify/stages').stage('sqlite-migration').deadlineMs)
        .to.equal(stage.deadlineMs);
    });

    it('records repeated clean measurements and explicit deadlines', function() {
      const fixture = readFixture();
      const requiredStages = [
        'lint',
        'unitCoverage',
        'sqliteMigration',
        'cssBuildDiff',
        'package',
      ];

      expect(fixture.schemaVersion).to.equal(1);
      expect(Object.keys(fixture.local).sort()).to.deep.equal(requiredStages.sort());
      requiredStages.forEach(name => expectLocalStage(name, fixture.local[name]));
    });

    it('derives a bounded stress count from captured observations', function() {
      const stress = readFixture().stress;

      expectCommand(stress.command);
      expectIsoDate(stress.capturedAt);
      expect(stress.nodeVersion).to.match(/^v22\./);
      expect(stress.observations).to.have.lengthOf.at.least(3);
      stress.observations.forEach(observation => {
        expect(observation.iterations).to.be.a('number').and.be.greaterThan(0);
        expect(observation.durationMs).to.be.a('number').and.be.greaterThan(0);
        expect(observation.failures).to.equal(0);
      });
      expect(stress.selectionRule).to.equal(
        'largest measured iteration count completing under 30000ms, capped at 25'
      );
      expect(stress.iterationCount).to.equal(
        Math.min(25, Math.max(...stress.observations
          .filter(observation => observation.durationMs < 30000)
          .map(observation => observation.iterations)))
      );
    });
  });

  describe('public Actions probe', function() {
    for (const [name, mutate] of [
      ['unrelated branch', value => { value.evidence.branch = 'other'; }],
      ['unrelated SHA', value => { value.evidence.headSha = '0'.repeat(40); }],
      ['different run URL', value => { value.evidence.sourceUrl = value.evidence.sourceUrl.replace(/\d+$/, '1'); }],
      ['different endpoint workflow', value => { value.endpoint = value.endpoint.replace('core-ci.yml', 'core-integration.yml'); }],
      ['different query branch', value => { value.endpoint = value.endpoint.replace('branch=master', 'branch=other'); }],
      ['coherent but unselected run', value => { value.evidence.runId = 1; value.evidence.sourceUrl = value.evidence.sourceUrl.replace(/\d+$/, '1'); }],
    ]) {
      it(`rejects ${name}`, function() {
        const result = readFixture().external.publicProbe.coreCi;
        mutate(result);
        expect(() => expectPublicResult('core-ci.yml', result)).to.throw();
      });
    }

    it('rejects duplicate job identities across browser shards', function() {
      const result = readFixture().external.publicProbe.coreIntegration;
      result.evidence.jobs[1].id = result.evidence.jobs[0].id;
      expect(() => expectPublicResult('core-integration.yml', result)).to.throw();
    });

    it('stores complete evidence bound to the historical selection', function() {
      const publicProbe = readFixture().external.publicProbe;

      expectPublicResult('core-ci.yml', publicProbe.coreCi);
      expectPublicResult('core-integration.yml', publicProbe.coreIntegration);
    });

    for (const [name, mutate] of [
      ['missing contour', value => { delete value.publicProbe.coreCi; }],
      ['ambiguous selection', value => { value.selection.runIds.coreCi = [1, 2]; }],
      ['missing prerequisite', value => { value.publicProbe.coreCi.result = 'missing_prerequisite'; }],
      ['failed run', value => { value.publicProbe.coreCi.evidence.conclusion = 'failure'; }],
      ['missing browser shard', value => { value.publicProbe.coreIntegration.evidence.jobs.pop(); }],
      ['duplicate job name', value => { value.publicProbe.coreIntegration.evidence.jobs[1].name = 'Browser suite 1/4'; }],
      ['job reused across workflows', value => { value.publicProbe.coreIntegration.evidence.jobs[0].id = value.publicProbe.coreCi.evidence.jobs[0].id; }],
      ['job completed after capture', value => { value.publicProbe.coreCi.evidence.capturedAt = '2026-01-01T00:00:00Z'; }],
    ]) {
      it(`rejects complete calibration with ${name}`, function() {
        const external = readFixture().external;
        mutate(external);
        expect(() => validateCiCalibration(external)).to.throw();
      });
    }

    it('does not commit credentials, environment values, or raw logs', function() {
      const serialized = fs.readFileSync(FIXTURE_PATH, 'utf8');

      expect(serialized).not.to.match(/gh[pousr]_[A-Za-z0-9_]+/);
      expect(serialized).not.to.match(/(?:token|password|authorization|environment|raw[_-]?log)\s*"?\s*:/i);
    });
  });

  describe('complete CI calibration evidence', function() {
    it('enforces the same identity boundary when loading the actual stage registry', function() {
      const result = spawnSync(process.execPath, ['-e', `
        const fixture = require('./t/fixtures/verify/stage_timings.json');
        fixture.external.publicProbe.coreCi.evidence.branch = 'unrelated';
        require('./lib/verify/stages');
      `], {cwd: path.join(__dirname, '../../..'), encoding: 'utf8', timeout: 5000});
      expect(result.error).to.equal(undefined);
      expect(result.status).to.equal(1);
      expect(result.stderr).to.include('Inconsistent CI calibration identity');
    });

    it('rejects any remaining missing external contour', function() {
      const publicProbe = readFixture().external.publicProbe;

      expect(publicProbe.coreCi.result).to.equal('available');
      expect(publicProbe.coreIntegration.result).to.equal('available');
    });
  });
});
