'use strict';

/*
  Spawn a child in its own process group, and kill the group rather than the
  child.

  A test batch is three processes, not one: mocha starts chromedriver, which
  starts Chrome. The runner kills mocha when a batch stops making progress, and
  SIGKILL cannot be caught, so nothing gets the chance to close the browser.
  chromedriver and Chrome are reparented to init and stay - and so does every
  browser from every batch killed before them.

  Measured on a development machine after a few days of this: 1494 surviving
  Chrome processes holding 22.6 GB on a machine with 16 GB, 165 of the 166
  browser sessions with no parent left, the oldest two and a half days old. The
  machine had 0.1 GB of memory free and 17 of its 18 GB of swap in use, and a
  fresh run could no longer start a browser at all - selenium answers
  UnsupportedOperationError when it cannot get a session.

  CI does not show it because the runner reaps orphans itself between jobs
  ("Terminate orphan process: chromedriver"), which is a hint that the runs are
  leaving them behind rather than evidence that they are not.

  A process group is the smallest thing that covers this: the child leads one,
  everything it starts inherits it, and one signal reaches all of them.

  Two costs of `detached`, both handled by the caller rather than here, because
  neither is this function's to decide:

  - a detached child is out of the terminal's foreground group, so Ctrl-C no
    longer reaches it. Whoever spawns has to forward the interrupt, or an
    interrupted run leaks exactly what this is here to prevent.
  - a detached child outlives its parent. The runner sweeps the group after the
    child exits, which also catches a chromedriver that survived an ordinary
    exit because its driver.quit() timed out.
*/

const { spawn } = require('child_process');

// Windows has no process groups in this sense, and process.kill does not accept
// a negative pid there. The runner falls back to killing the child alone, which
// is what it did everywhere before this.
const GROUPS_SUPPORTED = process.platform !== 'win32';

const DEFAULT_GRACE_MS = 5000;

const spawnInGroup = (command, args, options = {}) => spawn(
  command,
  args,
  Object.assign({detached: GROUPS_SUPPORTED}, options)
);

/*
  Returns whether anything was there to signal. ESRCH means the group is already
  gone, which is the ordinary case when sweeping after a clean exit and is not
  worth reporting as a failure.
*/
const killGroup = (child, signal) => {
  if (!child || !child.pid) {
    return false;
  }

  try {
    if (GROUPS_SUPPORTED) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }

    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }

    throw error;
  }
};

/*
  SIGTERM first: mocha handles it, and a browser closed by driver.quit() takes
  its chromedriver with it, which is tidier than killing three processes from
  the outside. SIGKILL after the grace period is what actually guarantees it -
  the whole reason this exists is that the thing being killed is already known
  not to be responding.
*/
const terminateGroup = (child, options = {}) => {
  const graceMs = options.graceMs === undefined ? DEFAULT_GRACE_MS : options.graceMs;
  const outcome = {
    termSent: killGroup(child, 'SIGTERM'),
    graceExited: false,
    killSent: false,
    finalSweepSent: false,
  };

  return new Promise(resolve => {
    let settled = false;

    const finish = reason => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      if (reason === 'exit') {
        outcome.graceExited = true;
        // A process-group leader can exit before a descendant that it started.
        // Sweep once more so an ordinary exit cannot leave that descendant alive.
        outcome.finalSweepSent = killGroup(child, 'SIGKILL');
      } else {
        outcome.killSent = killGroup(child, 'SIGKILL');
      }
      resolve(outcome);
    };

    // Not unref'd: it only exists between the SIGTERM and the SIGKILL, and
    // letting the process exit in that gap is letting the group survive.
    const timer = setTimeout(() => finish('deadline'), graceMs);

    child.once('exit', () => finish('exit'));
  });
};

module.exports = {
  DEFAULT_GRACE_MS,
  GROUPS_SUPPORTED,
  killGroup,
  spawnInGroup,
  terminateGroup,
};
