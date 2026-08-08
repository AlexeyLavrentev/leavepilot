'use strict';

/*
  A rejection nobody handled is how the browser suite loses ten minutes.

  The specs build promise chains and end them with done, and the terminal
  .catch(done) is often attached to an inner chain while the outer one has
  none. When something in there rejects, done is never called, so the test does
  not fail: it sits until mocha's 120s budget runs out and reports

    Timeout of 120000ms exceeded. For async tests and hooks, ensure "done()" is
    called; if returning a Promise, ensure it resolves.

  with no indication of the cause. bin/test.js then retries the whole batch and,
  where the process never exits, kills it after 300s and retries again.

  Both CI hangs looked like that. The last thing either printed was
  submit_form's fallback reading the flash messages one final time before
  throwing "Timed out waiting for flash message" - a perfectly good error that
  nothing was left to receive.

  Not every unhandled rejection means that, though, and this is the part worth
  being careful about. A WebDriver command belonging to a chain the suite has
  moved on from can reject long after anybody cares - a StaleElementReference
  once the page has navigated, say. submit_form's withDeadline swallows exactly
  those on purpose. Failing on the first unhandled rejection turns those
  stragglers into red runs, which is worse than the problem: one showed up on
  the first full run of this file.

  So the rule is not "a rejection nobody handled" but "a rejection nobody
  handled, after which the test never finished". A straggler does not stop its
  test from settling, and settling clears the alarm. A lost fatal rejection
  leaves the test hanging, nothing clears anything, and the alarm goes off with
  the cause in hand - in a few seconds rather than at the far end of two
  timeouts and a retry.

  It does not fix whatever makes a flash message late. It is the difference
  between finding out and not.
*/

const GRACE_MS = Number(process.env.TEST_LOST_REJECTION_GRACE_MS) > 0
  ? Number(process.env.TEST_LOST_REJECTION_GRACE_MS)
  : 30000;

let runningTest = null;
let alarm = null;
let suspect = null;

const describeError = error => {
  if (error instanceof Error) {
    return error.stack || (error.name + ': ' + error.message);
  }

  try {
    return require('util').inspect(error, {depth: 3});
  } catch (inspectionFailed) {
    return String(error);
  }
};

const report = kind => {
  process.stderr.write(
    '\n'
    + '  ' + kind + '\n'
    + '  while running: ' + (runningTest || '(no test in progress)') + '\n\n'
    + '  ' + describeError(suspect).split('\n').join('\n  ') + '\n\n'
    + '  Nothing handled this and the test never finished, so it would have run\n'
    + '  out its whole budget and reported a timeout with no cause. Failing here\n'
    + '  instead, ' + GRACE_MS + 'ms after the rejection.\n\n'
  );
};

// Crossing a test boundary means the suite is still moving, so whatever
// rejected was not the thing holding it up.
const standDown = () => {
  if (alarm) {
    clearTimeout(alarm);
    alarm = null;
  }
  suspect = null;
};

process.on('unhandledRejection', error => {
  suspect = error;

  if (alarm) {
    clearTimeout(alarm);
  }

  alarm = setTimeout(() => {
    report('LOST REJECTION, AND THE TEST NEVER FINISHED');
    process.exit(1);
  }, GRACE_MS);

  // Never the reason the process stays alive - only ever the reason it stops.
  if (typeof alarm.unref === 'function') {
    alarm.unref();
  }
});

/*
  An exception thrown outside any promise - from a bare setTimeout, or a driver
  callback - misses mocha's handler the same way, and unlike a rejection there
  is no abandoned-chain case to be careful about.
*/
process.on('uncaughtException', error => {
  suspect = error;
  report('UNCAUGHT EXCEPTION');
  process.exit(1);
});

exports.mochaHooks = {
  beforeEach() {
    if (this.currentTest) {
      runningTest = this.currentTest.fullTitle();
    }
    standDown();
  },

  afterEach() {
    standDown();
  },
};
