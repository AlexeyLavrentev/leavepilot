'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync, spawnSync} = require('child_process');
const {expect} = require('chai');

const runner = path.resolve(__dirname, '../../../bin/verify.js');

describe('verification source provenance at the actual Git/CLI boundary', function() {
  this.timeout(15000);
  let directory;
  let initialHead;

  const git = args => execFileSync('git', [
    '-c', 'user.name=Verifier test', '-c', 'user.email=verifier@example.test',
    '-c', 'commit.gpgsign=false', ...args,
  ], {cwd: directory, encoding: 'utf8', timeout: 5000});
  const write = (file, contents) => fs.writeFileSync(path.join(directory, file), contents);
  const commit = () => { git(['add', '.']); git(['commit', '-qm', 'fixture']); };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-source-'));
    git(['init', '-q']);
    write('.gitignore', '.artifacts/\n');
    write('package.json', JSON.stringify({name: 'verify-source-fixture', version: '1.0.0', files: ['package.json']}));
    commit();
    initialHead = git(['rev-parse', 'HEAD']).trim();
  });

  afterEach(() => fs.rmSync(directory, {recursive: true, force: true}));

  function verify() {
    const result = spawnSync(process.execPath, [runner, '--stage', 'package'], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: {...process.env, npm_config_cache: path.join(directory, '.artifacts/npm-cache'), npm_config_ignore_scripts: 'false'},
    });
    expect(result.status, result.stderr).to.equal(0);
    const line = result.stdout.split('\n').find(value => value.startsWith('VERIFY_SUMMARY '));
    const summary = JSON.parse(line.slice('VERIFY_SUMMARY '.length));
    const runRoot = path.dirname(summary.stages[0].attempts[0].evidence);
    const validation = spawnSync(process.execPath, [runner, '--validate-run-root', runRoot, '--expected-head', initialHead], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
    });
    return {summary, validation};
  }

  it('certifies a clean unchanged checkout, ignoring generated artifacts', () => {
    const {summary, validation} = verify();
    expect(summary.headSha).to.equal(initialHead);
    expect(summary.source).to.deep.equal({start: {headSha: initialHead, clean: true}, end: {headSha: initialHead, clean: true}});
    expect(summary.authoritative).to.equal(true);
    expect(validation.status, validation.stderr).to.equal(0);
  });

  for (const state of ['working tree', 'index', 'untracked source']) {
    it(`runs but cannot certify ${state} changes as the committed revision`, () => {
      if (state === 'untracked source') { write('new_source.js', 'module.exports = 2;\n'); }
      else {
        write('package.json', JSON.stringify({name: 'verify-source-fixture', version: '2.0.0', files: ['package.json']}));
        if (state === 'index') { git(['add', 'package.json']); }
      }
      const {summary, validation} = verify();
      expect(summary.aggregate).to.equal('passed');
      expect(summary.headSha).to.equal(initialHead);
      expect(summary.source.start.clean).to.equal(false);
      expect(summary.authoritative).to.equal(false);
      expect(validation.status).to.equal(2);
    });
  }

  for (const commitDuringRun of [false, true]) {
    it(`rejects source ${commitDuringRun ? 'committed' : 'modified'} by a stage and preserves the initial SHA`, () => {
      write('package.json', JSON.stringify({
        name: 'verify-source-fixture', version: '1.0.0', files: ['package.json'],
        scripts: {prepack: 'node mutate.cjs'},
      }));
      write('marker', 'before');
      write('mutate.cjs', [
        "require('fs').writeFileSync('marker', 'after');",
        commitDuringRun ? "const git = args => require('child_process').execFileSync('git', ['-c', 'user.name=Verifier test', '-c', 'user.email=verifier@example.test', '-c', 'commit.gpgsign=false', ...args]); git(['add', 'marker']); git(['commit', '-qm', 'stage change']);" : '',
      ].join('\n'));
      commit();
      initialHead = git(['rev-parse', 'HEAD']).trim();
      const {summary, validation} = verify();
      expect(summary.source.start).to.deep.equal({headSha: initialHead, clean: true});
      expect(summary.headSha).to.equal(initialHead);
      expect(summary.source.end.clean).to.equal(commitDuringRun);
      if (commitDuringRun) { expect(summary.source.end.headSha).not.to.equal(initialHead); }
      expect(summary.authoritative).to.equal(false);
      expect(validation.status).to.equal(2);
    });
  }
});
