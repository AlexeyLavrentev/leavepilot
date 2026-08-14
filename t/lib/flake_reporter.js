'use strict';

const fs = require('fs');
const Mocha = require('mocha');

/*
  Flake reporter (D-06): delegates every line of rendering to mocha's own
  Spec reporter and, beside it, records the two events only a reporter on
  the runner bus can see:

  - 'retry' - a test failed an attempt and mocha will re-run it inside this
    same process (--retries). The event carries the test and the error of
    the attempt that just failed; test.currentRetry() is that attempt's
    0-based number, stored 1-based so a fail-once-pass-second test reads as
    attempt 1 of the run it belongs to.
  - 'pending' - a test that will not run (self-skipped or declared
    pending): the raw material of skip honesty (D-21).

  The records are flushed as one JSON sidecar
  { retries: [...], pending: [...] } to the path in FLAKE_ARTIFACT_PATH
  when the runner fires 'end'. With the env unset the reporter is
  render-only - harmless under a plain mocha invocation, which is what lets
  the same class serve the runner and this file's own spec.

  spec identity: test.file (verified carried on retry/pending events in
  mocha 11.8); the reporter-option fallbackSpec - the runner's batch
  identity - is the documented A2 fallback if a mocha upgrade ever stops
  carrying it. Never stdout parsing.

  Security note (T-05-01): records carry test titles, spec paths and error
  messages only - never process.env values - mirroring the value-suppression
  contract of t/unit/env_deprecation.js.
*/
module.exports = class FlakeReporter extends Mocha.reporters.Spec {
  constructor(runner, options) {
    super(runner, options);

    const fallbackSpec = options
      && options.reporterOption
      && options.reporterOption.fallbackSpec;

    const retries = [];
    const pending = [];

    runner.on('retry', (test, error) => {
      retries.push({
        spec: test.file || fallbackSpec || null,
        title: test.fullTitle(),
        attempt: test.currentRetry() + 1,
        error: error && error.message ? String(error.message) : null,
      });
    });

    runner.on('pending', test => {
      pending.push({
        spec: test.file || fallbackSpec || null,
        title: test.fullTitle(),
      });
    });

    runner.once('end', () => {
      const sidecarPath = process.env.FLAKE_ARTIFACT_PATH;

      if (!sidecarPath) {
        return; // Not runner-driven: render-only.
      }

      try {
        fs.writeFileSync(sidecarPath, JSON.stringify({ retries, pending }, null, 2) + '\n');
      } catch (error) {
        // The sidecar is diagnostic: a failed write must not take the run
        // down with it. The runner reads a missing sidecar as "no records".
        console.error(`flake reporter: could not write ${sidecarPath}: ${error.message}`);
      }
    });
  }
};
