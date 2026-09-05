'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawnSync, execFileSync} = require('child_process');
const {expect} = require('chai');
const registry = require('../../../lib/verify/stages');

const root = path.resolve(__dirname, '../../..');
const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const validate = args => spawnSync(process.execPath, ['bin/verify.js', ...args], {cwd: root, encoding: 'utf8', timeout: 10000});

describe('verification evidence certification', () => {
  let directory;
  let runRoot;
  let summary;
  let pointer;

  function writeSummary() {
    fs.writeFileSync(path.join(runRoot, 'summary.json'), JSON.stringify(summary));
  }

  function certify(extra = []) {
    return validate(['--validate-run-path-file', pointer, '--expected-head', head, '--started-after', '2026-01-01T00:00:00Z', ...extra]);
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(root, '.artifacts/verify/evidence-test-'));
    const invocationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    runRoot = path.join(directory, `${Date.parse(startedAt)}-${invocationId}`);
    fs.mkdirSync(runRoot);
    summary = {schemaVersion: 1, invocationId, startedAt, headSha: head, profile: 'full', authoritative: true, quarantineCount: 0, aggregate: 'passed', stages: registry.profile('full').stageIds.map(id => {
      const stage = registry.stage(id);
      return {id, status: 'passed', failureClass: null, reason: null, durationMs: 1, attempts: [{number: 1, status: 'passed', evidence: path.join(runRoot, `${id}.attempt-1.json`), reproduction: {command: stage.command, args: stage.args, nodeVersion: process.version, dbContour: 'sqlite', featureFlags: 'not-recorded'}}]};
    })};
    summary.stages.forEach(stage => fs.writeFileSync(stage.attempts[0].evidence, JSON.stringify(stage)));
    writeSummary();
    pointer = path.join(directory, 'current.path');
    fs.writeFileSync(pointer, runRoot + '\n');
  });

  afterEach(() => fs.rmSync(directory, {recursive: true, force: true}));

  it('accepts complete first-pass evidence with matching identity and files', () => {
    const result = certify();
    expect(result.status, result.stderr).to.equal(0);
  });

  for (const [name, options] of [
    ['wrong SHA', ['--expected-head', '0'.repeat(40)]],
    ['stale start', ['--started-after', '2099-01-01T00:00:00Z']],
    ['invalid date', ['--started-after', 'not-a-date']],
  ]) {
    it(`rejects ${name} from the actual CLI options`, () => {
      expect(certify(options).status).to.equal(2);
    });
  }

  for (const [name, mutate] of [
    ['empty stages', () => { summary.stages = []; }],
    ['missing browser shard', () => { summary.stages.pop(); }],
    ['duplicate stages', () => { summary.stages[8] = summary.stages[7]; }],
    ['non-authoritative quick evidence', () => { summary.authoritative = false; summary.profile = 'quick'; }],
    ['wrong invocation identity', () => { summary.invocationId = crypto.randomUUID(); }],
    ['missing attempt file', () => { fs.unlinkSync(summary.stages[0].attempts[0].evidence); }],
    ['different attempt contents', () => { fs.writeFileSync(summary.stages[0].attempts[0].evidence, '{}'); }],
    ['diagnostic pass after failure', () => { summary.stages[0].attempts.unshift({number: 1, status: 'failed'}); }],
    ['active quarantine', () => { summary.quarantineCount = 1; }],
    ['escaping attempt path', () => { summary.stages[0].attempts[0].evidence = '/tmp/outside.json'; }],
    ['secret-bearing reproduction arguments', () => { summary.stages[0].attempts[0].reproduction.args = ['secret=sentinel-secret']; }],
    ['unexpected secret-bearing metadata', () => { summary.environment = {password: 'sentinel-secret'}; }],
  ]) {
    it(`rejects ${name}`, () => {
      mutate();
      writeSummary();
      expect(certify().status).to.equal(2);
    });
  }

  it('rejects an attempt-file symlink even when its contents match', () => {
    const evidence = summary.stages[0].attempts[0].evidence;
    const other = path.join(directory, 'other.json');
    fs.renameSync(evidence, other);
    fs.symlinkSync(other, evidence);
    expect(certify().status).to.equal(2);
  });

  function ciBundle() {
    const bundle = path.join(directory, 'ci');
    fs.mkdirSync(bundle);
    const runs = [];
    for (const id of [...registry.profile('full').stageIds, 'mysql-dialect']) {
      const startedAt = new Date().toISOString();
      const invocationId = crypto.randomUUID();
      const name = `${Date.parse(startedAt)}-${invocationId}`;
      const dir = path.join(bundle, '123', `verify-${id}`, name);
      fs.mkdirSync(dir, {recursive: true});
      const entry = registry.stage(id);
      const stage = {id, status: 'passed', failureClass: null, reason: null, durationMs: 1, attempts: [{number: 1, status: 'passed', evidence: `/home/runner/work/repo/.artifacts/verify/${name}/${id}.attempt-1.json`, reproduction: {command: entry.command, args: entry.args, nodeVersion: process.version, dbContour: id === 'mysql-dialect' ? 'mysql' : 'sqlite', featureFlags: 'not-recorded'}}]};
      const record = {...summary, profile: null, invocationId, startedAt, stages: [stage]};
      fs.writeFileSync(path.join(dir, `${id}.attempt-1.json`), JSON.stringify(stage));
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(record));
      runs.push({dir, record});
    }
    return {bundle, runs};
  }

  it('validates combined downloaded CI roots without rewriting original paths', () => {
    const {bundle} = ciBundle();
    const result = validate(['--validate-run-root', bundle, '--expected-head', head]);
    expect(result.status, result.stderr).to.equal(0);
  });

  for (const [name, alter] of [
    ['missing lint contour', runs => fs.rmSync(runs[0].dir, {recursive: true})],
    ['failed contour', runs => { runs[0].record.aggregate = 'failed'; fs.writeFileSync(path.join(runs[0].dir, 'summary.json'), JSON.stringify(runs[0].record)); }],
    ['mixed revisions', runs => { runs[0].record.headSha = '0'.repeat(40); fs.writeFileSync(path.join(runs[0].dir, 'summary.json'), JSON.stringify(runs[0].record)); }],
    ['missing summary', runs => fs.unlinkSync(path.join(runs[0].dir, 'summary.json'))],
  ]) {
    it(`rejects CI bundles with ${name}`, () => {
      const {bundle, runs} = ciBundle();
      alter(runs);
      expect(validate(['--validate-run-root', bundle, '--expected-head', head]).status).to.equal(2);
    });
  }
});
