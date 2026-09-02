'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {expect} = require('chai');

const ROOT = path.join(__dirname, '..', '..', '..');
const RUNNER = path.join(ROOT, 'bin', 'verify.js');
const run = args => spawnSync(process.execPath, [RUNNER].concat(args), {
  cwd: ROOT,
  encoding: 'utf8',
  env: Object.assign({}, process.env, {VERIFY_TEST_MODE: 'true'}),
});

describe('verify runner', () => {
  it('rejects empty and unknown selections without starting a stage', () => {
    const empty = run(['--stage']);
    const unknown = run(['--stage', 'nope']);
    expect(empty.status).to.equal(2);
    expect(unknown.status).to.equal(2);
    expect(unknown.stdout + unknown.stderr).to.contain('Unknown stage');
  });

  it('runs exactly one selected stage and writes a current invocation pointer', () => {
    const pointer = path.join(os.tmpdir(), `leavepilot-verify-${process.pid}.txt`);
    try { fs.unlinkSync(pointer); } catch (_) { /* absent */ }
    const result = run(['--stage', 'test-pass', '--run-path-file', pointer]);
    expect(result.status, result.stderr).to.equal(0);
    const runRoot = fs.readFileSync(pointer, 'utf8').trim();
    const summary = JSON.parse(fs.readFileSync(path.join(runRoot, 'summary.json'), 'utf8'));
    expect(summary.stages.map(stage => stage.id)).to.deep.equal(['test-pass']);
    expect(summary.stages[0].status).to.equal('passed');
    expect(path.isAbsolute(runRoot)).to.equal(true);
  });

  it('blocks dependents but continues independent stages in registry order', () => {
    const result = run(['--profile', 'test-graph']);
    expect(result.status).to.equal(1);
    const line = (result.stdout + result.stderr).split('\n').find(value => value.startsWith('VERIFY_SUMMARY '));
    const summary = JSON.parse(line.slice('VERIFY_SUMMARY '.length));
    expect(summary.stages.map(stage => `${stage.id}:${stage.status}`)).to.deep.equal([
      'test-fail:failed', 'test-blocked:blocked', 'test-pass:passed',
    ]);
  });
});
