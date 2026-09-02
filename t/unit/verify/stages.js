'use strict';

const path = require('path');
const {expect} = require('chai');
const registry = require('../../../lib/verify/stages');

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
    const browser = registry.stage('browser-1');
    expect(browser.prerequisite.command).to.equal(process.execPath);
    expect(browser.prerequisite.args).to.deep.equal(['bin/browser_setup.js', '--check']);
    expect(browser.prerequisite.setup).to.equal('node bin/browser_setup.js --bootstrap');
  });

  it('keeps artifact roots below the repository fixed path', () => {
    expect(registry.artifactRoot).to.equal(path.join('.artifacts', 'verify'));
  });
});
