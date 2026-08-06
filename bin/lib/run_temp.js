'use strict';

/*
  A directory of its own for everything a run writes to temp, so that clearing
  up afterwards is one delete rather than a guess.

  Chrome makes a fresh profile per WebDriver session - the
  org.chromium.Chromium.scoped_dir.* directories - and does not remove it when
  the session ends. Not only when a run is killed: a clean run of one spec, ten
  tests passing and driver.quit() returning normally, still leaves one behind.
  With one per driver and a spec file per driver, a full run leaves dozens.

  Measured on a development machine: 7439 of them, 10.17 GB, accumulated over a
  few days of runs. The oldest were older than the newest by two days, and
  nothing was ever going to remove them.

  Sweeping by name and age was the obvious alternative and is the worse one: it
  guesses which directories belong to this run, and guesses wrong about a second
  run started alongside it. Handing the children their own TMPDIR means the
  question does not arise - everything a run writes to temp is under one
  directory this created, and removing that directory removes exactly the run's
  own leavings and nothing else.

  Node, Chrome and chromedriver all honour TMPDIR on POSIX. On Windows they
  read TEMP and TMP, so all three are set.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'timeoff-test-';

const createRunTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));

/*
  The variables a child process reads to decide where temp is. Returned rather
  than applied, so the caller merges them into the environment it was building
  anyway and there is one place that describes what the children inherit.
*/
const temporaryDirectoryEnv = directory => ({
  TMPDIR: directory,
  TEMP: directory,
  TMP: directory,
});

/*
  Called on the way out of a run, including the failing and interrupted ways, so
  it has to be safe to call twice and safe to call on a directory that is not
  there. A run that cannot clear up after itself should not turn a red suite
  into a crash on the way out.
*/
const removeRunTemp = directory => {
  if (!directory || path.basename(directory).indexOf(PREFIX) !== 0) {
    return false;
  }

  try {
    fs.rmSync(directory, {recursive: true, force: true});
    return true;
  } catch (error) {
    process.stderr.write('Could not remove ' + directory + ': ' + error.message + '\n');
    return false;
  }
};

module.exports = {
  PREFIX,
  createRunTemp,
  removeRunTemp,
  temporaryDirectoryEnv,
};
