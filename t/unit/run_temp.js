'use strict';

/*
  Chrome makes a profile directory per WebDriver session - the
  org.chromium.Chromium.scoped_dir.* ones - and does not remove it when the
  session ends. Not only when a run is killed: a clean run of one spec, ten
  tests passing and driver.quit() returning normally, left one behind.

  With one per driver and a driver per spec file, a full run left dozens.
  Measured on a development machine: 7439 of them, 10.17 GB, accumulated over a
  few days, the oldest two days older than the newest, and nothing was ever
  going to remove them.

  Two halves to the fix, and neither works alone:

  - the driver is told where to put its profile, so it is somewhere known
    rather than somewhere Chrome picked;
  - the runner gives its children a temp directory of their own, and removes it
    when the run ends, which takes every profile in it.

  Sweeping the shared temp by name and age was the obvious alternative and is
  the worse one: it guesses which directories belong to this run and guesses
  wrong about a second run started alongside it.
*/

const expect = require('chai').expect;
const fs = require('fs');
const os = require('os');
const path = require('path');
const runTemp = require('../../bin/lib/run_temp');

const read = file => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

describe('The temp directory a run owns', function() {

  describe('creating it', function() {

    it('makes a directory of its own under the host temp', function() {
      const directory = runTemp.createRunTemp();

      try {
        expect(fs.existsSync(directory)).to.equal(true);
        // /var is a symlink to /private/var on macOS, so both sides resolve.
        expect(fs.realpathSync(path.dirname(directory)))
          .to.equal(fs.realpathSync(os.tmpdir()));
        expect(path.basename(directory)).to.match(new RegExp('^' + runTemp.PREFIX));
      } finally {
        fs.rmSync(directory, {recursive: true, force: true});
      }
    });

    it('makes a different one each time', function() {
      const first = runTemp.createRunTemp();
      const second = runTemp.createRunTemp();

      try {
        expect(first).to.not.equal(second);
      } finally {
        [first, second].forEach(d => fs.rmSync(d, {recursive: true, force: true}));
      }
    });
  });

  describe('what the children are told', function() {

    // Node reads TMPDIR on POSIX and TEMP/TMP on Windows, so a run that only
    // set one of them would leave the others pointing at the shared temp.
    it('names every variable a child reads for its temp directory', function() {
      expect(runTemp.temporaryDirectoryEnv('/somewhere')).to.deep.equal({
        TMPDIR: '/somewhere',
        TEMP: '/somewhere',
        TMP: '/somewhere',
      });
    });
  });

  describe('removing it', function() {

    it('takes the directory and everything in it', function() {
      const directory = runTemp.createRunTemp();

      fs.mkdirSync(path.join(directory, 'timeoff-chrome-abc'), {recursive: true});
      fs.writeFileSync(path.join(directory, 'timeoff-chrome-abc', 'Preferences'), '{}');

      expect(runTemp.removeRunTemp(directory)).to.equal(true);
      expect(fs.existsSync(directory)).to.equal(false);
    });

    /*
      Called on the way out of a run, including the failing and the interrupted
      ways, so it has to survive being called twice and being called on a
      directory that is already gone. A run that cannot clear up should not turn
      a red suite into a crash on the way out.
    */
    it('is safe to call twice', function() {
      const directory = runTemp.createRunTemp();

      expect(runTemp.removeRunTemp(directory)).to.equal(true);
      expect(runTemp.removeRunTemp(directory)).to.equal(true);
    });

    it('refuses a directory it did not make', function() {
      const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'not-ours-'));

      try {
        expect(runTemp.removeRunTemp(foreign)).to.equal(false);
        expect(fs.existsSync(foreign), 'it deleted something that was not its own').to.equal(true);
      } finally {
        fs.rmSync(foreign, {recursive: true, force: true});
      }
    });

    it('refuses nothing at all', function() {
      expect(runTemp.removeRunTemp('')).to.equal(false);
      expect(runTemp.removeRunTemp(null)).to.equal(false);
    });
  });

  describe('how the runner uses it', function() {

    const runner = read('bin/test.js')
      .split('\n')
      .filter(line => !/^\s*\/\//.test(line))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    it('makes one for the run', function() {
      expect(runner).to.match(/const runTemp = createRunTemp\(\)/);
    });

    it('hands it to the children', function() {
      expect(runner).to.match(/temporaryDirectoryEnv\(runTemp\)/);
    });

    it('removes it when the run ends, whether it passed or failed', function() {
      const removals = runner.match(/removeRunTemp\(runTemp\)/g) || [];

      expect(removals.length).to.be.at.least(
        3,
        'the passing path, the failing path and the interrupt all have to clear up'
      );
    });

    // A detached child is out of the terminal's foreground group, so the runner
    // is the only thing that sees the interrupt.
    it('removes it when the run is interrupted', function() {
      const handler = runner.slice(runner.indexOf("['SIGINT', 'SIGTERM']"));

      expect(handler.slice(0, 400)).to.include('removeRunTemp(runTemp)');
    });
  });

  describe('what the driver is told', function() {

    const driver = read('t/lib/build_driver.js');

    it('puts the browser profile somewhere known instead of somewhere Chrome picks', function() {
      expect(driver).to.match(/--user-data-dir=/);
    });

    /*
      Under os.tmpdir(), which inside a run is the directory above - node reads
      TMPDIR. Chrome does not: on macOS it asks the system for the user temp
      directory, which is why its own profiles land in /var/folders whatever
      TMPDIR says, and why telling it where to put the profile is the half that
      cannot be skipped.
    */
    it('puts it in the run temp directory when there is one', function() {
      expect(driver).to.match(/mkdtempSync\(path\.join\(os\.tmpdir\(\)/);
    });
  });
});
