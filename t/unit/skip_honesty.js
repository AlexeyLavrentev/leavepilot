'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {expect} = require('chai');

const root = path.resolve(__dirname, '../..');
const modes = {
  'it.skip': "it.skip('skipped', () => {});",
  'missing callback': "it('skipped');",
  'describe.skip': "describe.skip('suite', () => { it('skipped', () => {}); });",
  'before skip': "describe('suite', () => { before(function() { this.skip(); }); it('skipped', () => {}); });",
  'beforeEach skip': "describe('suite', () => { beforeEach(function() { this.skip(); }); it('skipped', () => {}); });",
  'test skip': "it('skipped', function() { this.skip(); });",
  'retried test skip': "it('skipped', function() { this.retries(1); if (!this.test.currentRetry()) { throw new Error('retry fixture'); } this.skip(); });",
};

describe('skip honesty through actual Mocha root hooks', function() {
  this.timeout(15000);
  let directory;

  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-honesty-')); });
  afterEach(() => { fs.rmSync(directory, {recursive: true, force: true}); });

  function files(source, count) {
    return Array.from({length: count}, (_, index) => {
      const file = path.join(directory, `spec-${index}.js`);
      fs.writeFileSync(file, source);
      return file;
    });
  }

  function run(specs, args = [], env = {}) {
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/mocha/bin/mocha'),
      '--require', path.join(root, 't/lib/skip_honesty.js'), '--reporter', 'json', ...args, ...specs], {
      cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: {...process.env, TEST_ENFORCE_SKIP_HONESTY: 'true', TEST_CANONICAL_VERIFY: 'false', ...env},
    });
    expect(result.error, result.stderr).to.equal(undefined);
    return {code: result.status, report: JSON.parse(result.stdout), stderr: result.stderr};
  }

  for (const [name, source] of Object.entries(modes)) {
    it(`rejects five distinct files skipped via ${name}`, () => {
      const result = run(files(source, 5));
      expect(result.report.stats.pending).to.equal(5);
      expect(result.code, JSON.stringify(result.report.stats)).to.equal(1);
      expect(result.report.failures[0].err.message).to.include('SKIP HONESTY BREACH');
    });
  }

  it('allows four distinct skipped files even with multiple skipped tests each', () => {
    const result = run(files(modes['it.skip'].repeat(2), 4));
    expect(result.report.stats.pending).to.equal(8);
    expect(result.code).to.equal(0);
  });

  it('does not count pending declarations excluded by grep', () => {
    const specs = files(modes['it.skip'], 5);
    const included = path.join(directory, 'included.js');
    fs.writeFileSync(included, "it.skip('included', () => {});");
    const result = run([...specs, included], ['--grep', 'included']);
    expect(result.report.stats.pending).to.equal(1);
    expect(result.code).to.equal(0);
  });

  it('warns locally without failing when enforcement is disabled', () => {
    const result = run(files(modes['it.skip'], 5), [], {TEST_ENFORCE_SKIP_HONESTY: 'false'});
    expect(result.report.stats.pending).to.equal(5);
    expect(result.code).to.equal(0);
    expect(result.stderr).to.include('WARNING: skip honesty breach');
  });

  it('enforces canonical verification even when the ordinary gate is disabled', () => {
    const result = run(files(modes['describe.skip'], 5), [], {
      TEST_ENFORCE_SKIP_HONESTY: 'false', TEST_CANONICAL_VERIFY: 'true',
    });
    expect(result.code).to.equal(1);
    expect(result.report.failures[0].err.message).to.include('SKIP HONESTY BREACH');
  });

  it('does not carry skipped files into a second run in the same process', () => {
    const skipped = files(modes['test skip'], 5);
    const clean = path.join(directory, 'clean.js');
    fs.writeFileSync(clean, "it('passes', () => {});");
    const result = spawnSync(process.execPath, ['-e', `
      const Mocha = require('mocha');
      const hooks = require('./t/lib/skip_honesty').mochaHooks;
      const first = new Mocha({reporter: 'dot', rootHooks: hooks});
      ${JSON.stringify(skipped)}.forEach(file => first.addFile(file));
      first.run(firstCode => {
        const second = new Mocha({reporter: 'dot', rootHooks: hooks});
        second.addFile(${JSON.stringify(clean)});
        second.run(secondCode => console.log('SKIP_RUN_CODES=' + JSON.stringify([firstCode, secondCode])));
      });`], {
      cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: {...process.env, TEST_ENFORCE_SKIP_HONESTY: 'true'},
    });
    expect(result.error, result.stderr).to.equal(undefined);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.include('SKIP_RUN_CODES=[1,0]');
  });
});
