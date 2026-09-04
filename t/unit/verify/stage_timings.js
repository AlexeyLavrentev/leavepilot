'use strict';

const fs = require('fs');
const path = require('path');
const {expect} = require('chai');

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
    expect(floor.workflow).to.equal('core-integration.yml');
    expect(floor.runId).to.be.a('number').and.be.greaterThan(0);
    expect(floor.job).to.match(/^Browser suite [1-4]\/4$/);
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

const expectRunIdentity = (name, evidence) => {
  expect(evidence.workflow).to.equal(name);
  expect(evidence.repository).to.equal('AlexeyLavrentev/timeoff');
  expect(evidence.branch).to.be.a('string').and.not.equal('');
  expect(evidence.headSha).to.match(/^[0-9a-f]{40}$/);
  expect(evidence.event).to.equal('push');
  expect(evidence.status).to.equal('completed');
  expect(evidence.conclusion).to.equal('success');
  expect(evidence.runId).to.be.a('number').and.be.greaterThan(0);
  expect(evidence.sourceUrl).to.match(
    /^https:\/\/github\.com\/AlexeyLavrentev\/(?:timeoff|leavepilot)\/actions\/runs\//
  );
  expectIsoDate(evidence.capturedAt);
  expect(evidence.jobs).to.be.an('array').and.not.be.empty;
  evidence.jobs.forEach(job => {
    expect(job.id).to.be.a('number').and.be.greaterThan(0);
    expect(job.name).to.be.a('string').and.not.equal('');
    expectIsoDate(job.startedAt);
    expectIsoDate(job.completedAt);
    expect(job.durationMs).to.equal(Date.parse(job.completedAt) - Date.parse(job.startedAt));
    expect(job.durationMs).to.be.greaterThan(0);
  });

  const jobNames = evidence.jobs.map(job => job.name).sort();
  if (name === 'core-ci.yml') {
    expect(jobNames).to.deep.equal(['Dialect-sensitive specs on MySQL 8.0.45']);
  } else {
    expect(jobNames).to.deep.equal([
      'Browser suite 1/4',
      'Browser suite 2/4',
      'Browser suite 3/4',
      'Browser suite 4/4',
    ]);
  }
};

const expectPublicResult = (name, result) => {
  expect(result.workflow).to.equal(name);
  expect(result.endpoint).to.match(/^https:\/\/api\.github\.com\/repos\/AlexeyLavrentev\/timeoff\/actions\/workflows\//);

  if (result.result === 'available') {
    expectRunIdentity(name, result.evidence);
    return;
  }

  expect(result.result).to.equal('missing_prerequisite');
  expect(result.failureClass).to.be.oneOf([
    'dns',
    'http',
    'parse',
    'empty_run',
    'ambiguous_run',
    'missing_job',
  ]);
  expect(result.reason).to.be.a('string').and.not.equal('');
  expect(result.fallbackCommand).to.equal(
    'rtk gh auth login -h github.com -p https -s repo,workflow'
  );
  expect(result).not.to.have.any.keys('durationMs', 'deadlineMs', 'samples');
};

describe('stage timing evidence', function() {
  describe('local calibration', function() {
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
    it('stores deterministic evidence or a typed authenticated fallback', function() {
      const publicProbe = readFixture().external.publicProbe;

      expectPublicResult('core-ci.yml', publicProbe.coreCi);
      expectPublicResult('core-integration.yml', publicProbe.coreIntegration);
    });

    it('does not commit credentials, environment values, or raw logs', function() {
      const serialized = fs.readFileSync(FIXTURE_PATH, 'utf8');

      expect(serialized).not.to.match(/gh[pousr]_[A-Za-z0-9_]+/);
      expect(serialized).not.to.match(/(?:token|password|authorization|environment|raw[_-]?log)\s*"?\s*:/i);
    });
  });

  describe('complete CI calibration evidence', function() {
    it('rejects any remaining missing external contour', function() {
      const publicProbe = readFixture().external.publicProbe;

      expect(publicProbe.coreCi.result).to.equal('available');
      expect(publicProbe.coreIntegration.result).to.equal('available');
    });
  });
});
