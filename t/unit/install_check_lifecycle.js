'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {expect} = require('chai');
const {killGroup} = require('../../bin/lib/spawn_group');
const root = path.resolve(__dirname, '../..');
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code !== 'ESRCH') { throw error; } return false; }
};

describe('install-check background ownership', function() {
  this.timeout(15000);

  for (const earlyExit of [true, false]) {
    it(`cleans descendants when the background leader ${earlyExit ? 'already exited' : 'is still running'}`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-background-'));
      let owned;
      try {
        fs.mkdirSync(path.join(directory, 'bin/lib'), {recursive: true});
        fs.mkdirSync(path.join(directory, 't/fixtures'), {recursive: true});
        // Execute unchanged runner/helper bytes in an isolated install root.
        // Synthetic docs never install packages, touch real .env or use Docker.
        for (const file of ['bin/install_check.js', 'bin/lib/spawn_group.js']) {
          fs.copyFileSync(path.join(root, file), path.join(directory, file));
        }
        fs.writeFileSync(path.join(directory, 'background.js'), `
          const {spawn} = require('child_process');
          const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], {stdio: 'ignore'});
          require('fs').writeFileSync('owned.json', JSON.stringify({leader: process.pid, leaf: leaf.pid}));
          ${earlyExit ? 'process.exit(0);' : 'setInterval(() => {}, 1000000);'}`);
        fs.writeFileSync(path.join(directory, 'wait.js'), `
          const fs = require('fs'); const deadline = Date.now() + 3000;
          const timer = setInterval(() => {
            if (fs.existsSync('owned.json')) {
              if (!${earlyExit}) { clearInterval(timer); return; }
              try { process.kill(JSON.parse(fs.readFileSync('owned.json')).leader, 0); }
              catch (error) { if (error.code === 'ESRCH') { clearInterval(timer); return; } throw error; }
            }
            if (Date.now() > deadline) { process.exit(1); }
          }, 20);`);
        fs.writeFileSync(path.join(directory, 'fixture.md'),
          '## Start\n```bash\nnode background.js\n```\n## Wait\n```bash\nnode wait.js\n```\n');
        fs.writeFileSync(path.join(directory, 't/fixtures/install-scenario.json'), JSON.stringify({
          slices: {fixture: [
            {doc: 'fixture.md', heading: 'Start', blockIndex: 0, expectCommand: 'node background.js', await: false},
            {doc: 'fixture.md', heading: 'Wait', blockIndex: 0, expectCommand: 'node wait.js'},
            {harness: 'stop_background_steps'},
          ]}, sliceOptions: {fixture: {loadDotEnv: false}},
        }));
        const result = spawnSync(process.execPath, ['bin/install_check.js', '--slice', 'fixture'], {
          cwd: directory, encoding: 'utf8', timeout: 8000, maxBuffer: 65536,
        });
        owned = JSON.parse(fs.readFileSync(path.join(directory, 'owned.json')));
        expect(result.error, result.stderr).to.equal(undefined);
        expect(result.status, result.stderr).to.equal(0);
        expect(result.stdout).to.include('passed (3 step(s) executed)');
        const deadline = Date.now() + 2000;
        while (alive(owned.leaf) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
        expect(alive(owned.leaf), 'background descendant survived').to.equal(false);
        expect(alive(owned.leader), 'background leader survived').to.equal(false);
      } finally {
        // Also clean a failing pre-fix reproduction, using only fixture PIDs.
        const ownedPath = path.join(directory, 'owned.json');
        if (!owned && fs.existsSync(ownedPath)) { owned = JSON.parse(fs.readFileSync(ownedPath)); }
        if (owned) {
          killGroup({pid: owned.leader}, 'SIGKILL');
        }
        fs.rmSync(directory, {recursive: true, force: true});
      }
    });
  }

  function stopFor(record, terminateGroup) {
    const source = fs.readFileSync(path.join(root, 'bin/install_check.js'), 'utf8');
    const implementation = source.slice(source.indexOf('function stopBackgroundSteps()'), source.indexOf('function killLiveChildren()'));
    return require('vm').runInNewContext(implementation + '\nstopBackgroundSteps;', {
      backgroundSteps: [record], liveChildren: new Set([record.child]), console: {log() {}}, terminateGroup,
    });
  }

  it('rejects failed cleanup even after the group leader has exited', async () => {
    const record = {child: {pid: 123}, exited: 0,
      termination: Promise.resolve({errors: [{signal: 'SIGKILL', code: 'EPERM'}]})};
    await require('assert').rejects(stopFor(record, () => { throw new Error('duplicate sweep'); })(),
      /Could not stop background process group/);
  });

  it('reuses one termination outcome across repeated shutdown calls', async () => {
    const record = {child: {pid: 123}, exited: null};
    let calls = 0;
    const stop = stopFor(record, async () => { calls += 1; return {errors: []}; });
    await stop();
    await stop();
    expect(calls).to.equal(1);
  });
});
