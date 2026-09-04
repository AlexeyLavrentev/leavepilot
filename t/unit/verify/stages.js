'use strict';

const path = require('path');
const fs = require('fs');
const {expect} = require('chai');
const registry = require('../../../lib/verify/stages');

const readWorkflow = name => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', '.github', 'workflows', name),
  'utf8'
);

describe('verify stage registry', () => {
  it('defines canonical local and CI contours from one frozen registry', () => {
    expect(registry.stages).to.be.an('array').and.not.be.empty;
    expect(Object.isFrozen(registry.stages)).to.equal(true);
    expect(registry.profile('full').stageIds).to.include.members([
      'lint', 'unit-coverage', 'sqlite-migration', 'css-build-diff', 'package',
      'browser-1', 'browser-2', 'browser-3', 'browser-4',
    ]);
    expect(registry.profile('quick').authoritative).to.equal(false);
    expect(registry.profile('ci-mysql').stageIds).to.deep.equal(['mysql-dialect']);
  });

  it('strictly resolves stages and profiles without accepting commands', () => {
    expect(registry.stage('lint').args).to.be.an('array');
    expect(() => registry.stage('lint;touch nope')).to.throw('Unknown stage');
    expect(() => registry.profile('unknown')).to.throw('Unknown profile');
  });

  it('uses measured local deadlines and a decisive Chrome prerequisite', () => {
    const lint = registry.stage('lint');
    expect(lint.deadlineMs).to.equal(3788);
    const unitCoverage = registry.stage('unit-coverage');
    expect(unitCoverage.deadlineMs).to.equal(220684);
    const cssBuildDiff = registry.stage('css-build-diff');
    expect(cssBuildDiff.deadlineMs).to.equal(1936);
    const browser = registry.stage('browser-1');
    expect(browser.prerequisite.command).to.equal(process.execPath);
    expect(browser.prerequisite.args).to.deep.equal(['bin/browser_setup.js', '--check']);
    expect(browser.prerequisite.setup).to.equal('node bin/browser_setup.js --bootstrap');
  });

  it('keeps artifact roots below the repository fixed path', () => {
    expect(registry.artifactRoot).to.equal(path.join('.artifacts', 'verify'));
  });

  it('keeps Core CI registry-selected, read-only, and evidence-complete', () => {
    const workflow = readWorkflow('core-ci.yml');
    const coreTests = workflow.slice(workflow.indexOf('  test:'), workflow.indexOf('  license-contract:'));
    const mysql = workflow.slice(workflow.indexOf('  mysql-dialect:'), workflow.indexOf('  security:'));

    expect(workflow).to.include('contents: read');
    expect(coreTests).to.include('node bin/verify.js --stage unit-coverage');
    expect(coreTests).to.not.include('npm run test:coverage');
    expect(mysql).to.include('node bin/verify.js --profile ci-mysql');
    expect(mysql).to.not.include('node bin/test.js ${specs}');
    expect(mysql).to.include('mysql:8.0.45');
    expect(workflow).to.match(/if: always\(\)[\s\S]{0,300}path: \.artifacts\/verify\/[\s\S]{0,100}if-no-files-found: error/);
  });

  it('keeps browser shards registry-selected and uploads every run root', () => {
    const workflow = readWorkflow('core-integration.yml');

    expect(workflow).to.include('fail-fast: false');
    expect(workflow).to.include('shard: [1, 2, 3, 4]');
    // eslint-disable-next-line no-template-curly-in-string
    expect(workflow).to.include('node bin/verify.js --stage browser-${{ matrix.shard }}');
    expect(workflow).to.not.include('node bin/test.js --integration-only');
    expect(workflow).to.match(/if: always\(\)[\s\S]{0,300}path: \.artifacts\/verify\/[\s\S]{0,100}if-no-files-found: error/);
    expect(workflow).to.not.include('continue-on-error');
  });
});
