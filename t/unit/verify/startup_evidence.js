'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync, spawn} = require('child_process');
const {expect} = require('chai');
const registry = require('../../../lib/verify/stages');

describe('startup failure evidence', function() {
  this.timeout(10000);

  for (const [id, phase, started, failureClass] of [
    ['test-prerequisite-fail', 'prerequisite', true, 'missing prerequisite'],
    ['test-prerequisite-timeout', 'prerequisite', true, 'timeout'],
    ['test-prerequisite-missing', 'prerequisite', false, 'missing prerequisite'],
    ['test-spawn-missing', 'stage', false, 'runner error'],
  ]) {
    it(`retains a failed attempt and replay for ${id}`, () => {
      const result = spawnSync(process.execPath, ['bin/verify.js', '--stage', id], {encoding: 'utf8', timeout: 9000,
        env: {...process.env, STARTUP_TEST_SECRET: 'startup-private-value'},
      });
      expect(result.status, result.stderr).to.equal(1);
      expect(result.stdout + result.stderr).not.to.include('unexpected-stage-start');
      expect(result.stdout + result.stderr).not.to.include('startup-private-value');
      const summary = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('VERIFY_SUMMARY ')).slice(15));
      const stage = summary.stages[0];
      expect(stage).to.include({id, status: 'failed', failureClass});
      expect(stage.attempts).to.have.lengthOf(1);
      const attempt = stage.attempts[0];
      const execution = phase === 'prerequisite' ? registry.stage(id).prerequisite : registry.stage(id);
      expect(stage.execution).to.deep.equal({phase, command: execution.command, args: execution.args, started});
      expect(attempt.reproduction.replay).to.deep.equal({command: 'node', args: ['bin/verify.js', '--stage', id]});
      expect(attempt.reproduction.diagnostics.latest.state).to.equal('unavailable');
      expect(JSON.parse(fs.readFileSync(attempt.evidence, 'utf8'))).to.deep.equal(stage);
      expect(fs.statSync(attempt.evidence).size).to.be.lessThan(32768);
      if (id === 'test-prerequisite-fail') {
        expect(stage.reason).to.include('probe began');
        expect(stage.reason).to.include('password=[REDACTED]');
      }
      if (failureClass === 'timeout') { expect(stage.termination).to.be.an('object'); }
    });
  }

  for (const action of ['release', 'SIGTERM', 'SIGINT']) {
    it(`publishes an incomplete pointer and records prerequisite ${action}`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-pointer-'));
      const pointer = path.join(directory, 'current.path');
      const release = path.join(directory, 'release');
      fs.writeFileSync(pointer, 'old-run');
      const child = spawn(process.execPath, ['bin/verify.js', '--stage', 'test-prerequisite-wait', '--run-path-file', pointer], {
        stdio: ['ignore', 'pipe', 'ignore'], env: {...process.env, STARTUP_TEST_RELEASE_FILE: release},
      });
      const done = new Promise(resolve => child.once('close', resolve));
      const ready = new Promise((resolve, reject) => {
        let output = '';
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.includes('prerequisite-waiting\n')) { resolve(); }
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Prerequisite exited before ready')));
      });
      try {
        await ready;
        const runRoot = fs.readFileSync(pointer, 'utf8').trim();
        expect(path.isAbsolute(runRoot)).to.equal(true);
        expect(fs.existsSync(path.join(runRoot, 'summary.json'))).to.equal(false);
        const check = spawnSync(process.execPath, ['bin/verify.js', '--validate-run-path-file', pointer], {encoding: 'utf8', timeout: 3000});
        expect(check.status).to.equal(2);
        if (action === 'release') { fs.writeFileSync(release, 'release'); }
        else { child.kill(action); }
        expect(await done).to.equal(action === 'release' ? 0 : action === 'SIGINT' ? 130 : 143);
        const summary = JSON.parse(fs.readFileSync(path.join(runRoot, 'summary.json'), 'utf8'));
        const stage = summary.stages[0];
        if (action === 'release') {
          expect(stage.status).to.equal('passed');
          expect(stage).not.to.have.property('execution');
        } else {
          expect(stage).to.include({status: 'failed', failureClass: 'runner error'});
          expect(stage.execution).to.include({phase: 'prerequisite', started: true});
          expect(stage.attempts).to.have.lengthOf(1);
          expect(stage.reason).to.include(`Interrupted by ${action}`);
          expect(stage.termination.groups.length).to.be.greaterThan(0);
          for (const group of stage.termination.groups) {
            expect(() => process.kill(group.pid, 0)).to.throw().with.property('code', 'ESRCH');
          }
        }
      } finally {
        fs.writeFileSync(release, 'release');
        await done;
        fs.rmSync(directory, {recursive: true, force: true});
      }
    });
  }
});
