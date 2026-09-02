'use strict';

/*
  Skip honesty (D-21): a spec that silently self-skips is a hole in the
  suite, so the skipped spec files are counted on every run. Counting is
  unconditional everywhere; FAILING on excess is gated on
  TEST_ENFORCE_SKIP_HONESTY, which only CI contours set (the core-ci
  coverage step, the core-integration shards, and later runner-driven CI
  jobs). A local run that breaches names the skipped files in a warning and
  keeps its own exit code - the same count, a softer verdict, so a
  driver-less laptop never goes red over specs that legitimately need
  hardware CI does not have either.

  The threshold is not zero on purpose: the four driver-dependent specs
  (browser_language, scroll_boundaries, spawn_group,
  reduced_transparency_honesty) self-skip honestly wherever their driver is
  absent. Changing MAX_ALLOWED_SKIPPED_SPECS is a visible commit with a
  rationale, never a silent drift.

  One rule, two carriers - this module is small enough to be loaded both
  ways:

  - as a mocha --require module (package.json test:coverage), where the
    mochaHooks below count pending tests and the root afterAll hook fails
    the run on a gated breach;
  - as a plain require from bin/test.js, which feeds the reporter's pending
    records into the same rule for runner-driven contours.

  The rule itself never throws and never exits: each carrier turns a gated
  breach into the failure its own process understands (mocha: a root-hook
  error; the runner: process.exitCode).
*/

const MAX_ALLOWED_SKIPPED_SPECS = 4;

const enforcementEnabled = () => {
  if (process.env.TEST_CANONICAL_VERIFY === 'true') {
    return true;
  }
  const value = process.env.TEST_ENFORCE_SKIP_HONESTY;
  return value === 'true' || value === '1' || value === 'yes';
};

const evaluateSkipHonesty = skippedFiles => {
  const distinct = Array.from(new Set((skippedFiles || []).filter(Boolean)));
  const breach = distinct.length > MAX_ALLOWED_SKIPPED_SPECS;
  const enforce = breach && enforcementEnabled();
  return { distinct, breach, enforce };
};

const breachMessage = evaluation =>
  'Skipped spec files ('
  + evaluation.distinct.length
  + ') exceed MAX_ALLOWED_SKIPPED_SPECS ('
  + MAX_ALLOWED_SKIPPED_SPECS
  + '):\n  '
  + evaluation.distinct.join('\n  ')
  + '\nEvery self-skipping spec is suite coverage that silently stopped'
  + '\nrunning. Restore what the spec needs, or raise'
  + '\nMAX_ALLOWED_SKIPPED_SPECS in t/lib/skip_honesty.js as a visible'
  + '\ncommit with a rationale.';

/*
  Reports a breach without throwing: warn-only unless the CI gate is set, in
  which case the caller fails its own process. Returns the evaluation so
  each carrier can act on { breach, enforce }.
*/
const reportSkipHonesty = skippedFiles => {
  const evaluation = evaluateSkipHonesty(skippedFiles);

  if (evaluation.breach && !evaluation.enforce) {
    console.warn(
      'WARNING: skip honesty breach - CI contours (TEST_ENFORCE_SKIP_HONESTY)'
      + ' would fail this run.\n'
      + breachMessage(evaluation)
    );
  }

  return evaluation;
};

/*
  Counting side, loaded via --require into a mocha process. afterEach sees
  every settled test - including pending ones (verified against mocha 11:
  a test that calls this.skip(), inside the test or a beforeEach, still runs
  the afterEach hook with this.currentTest.pending set and .file carried).
*/
const skippedByHooks = new Set();

exports.mochaHooks = {
  afterEach() {
    const test = this.currentTest;
    if (test && test.pending && test.file) {
      skippedByHooks.add(test.file);
    }
  },

  afterAll() {
    const evaluation = reportSkipHonesty(Array.from(skippedByHooks));

    if (!evaluation.enforce) {
      return;
    }

    /*
      Throwing is what fails a passing mocha run: mocha computes its exit
      code after the root hooks, so setting process.exitCode here would be
      clobbered (and inside process 'exit' it is too late to change at all -
      verified empirically).
    */
    throw new Error('SKIP HONESTY BREACH: TEST_ENFORCE_SKIP_HONESTY is set.\n' + breachMessage(evaluation));
  },
};

exports.MAX_ALLOWED_SKIPPED_SPECS = MAX_ALLOWED_SKIPPED_SPECS;
exports.evaluateSkipHonesty = evaluateSkipHonesty;
exports.reportSkipHonesty = reportSkipHonesty;
exports.breachMessage = breachMessage;
