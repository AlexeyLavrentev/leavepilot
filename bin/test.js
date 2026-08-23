#!/usr/bin/env node
/* eslint-disable no-console */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { spawnInGroup, killGroup, terminateGroup } = require('./lib/spawn_group');
const skipHonesty = require('../t/lib/skip_honesty');

/*
  Every batch this runner has going, so an interrupt can take their browsers
  with them. A detached child is out of the terminal's foreground group and
  never sees the Ctrl-C that stopped the runner.
*/
const liveChildren = new Set();

['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    liveChildren.forEach(child => killGroup(child, 'SIGKILL'));
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
});

const port = process.env.PORT || '3000';
const testHost = process.env.TEST_HOST || '127.0.0.1';
const host = `http://${testHost}:${port}`;
const node = process.execPath;
const dbStorage = process.env.TEST_DB_STORAGE || path.join(process.cwd(), 'db.test.sqlite');

/*
  TEST_DB_DIALECT selects the database contour the children run against
  (D-05). 'mysql' switches the child env to DB_DIALECT=mysql; every other
  value - including unset - keeps sqlite, which remains the default contour.
  The DB_* connection variables (DB_HOST, DB_PORT, DB_NAME, DB_USER,
  DB_PASSWORD) ride process.env through the Object.assign base untouched, so
  pointing them at a server is all a MySQL contour takes; DB_STORAGE is the
  sqlite file path and is simply ignored under mysql.
*/
const dbDialect = process.env.TEST_DB_DIALECT === 'mysql' ? 'mysql' : 'sqlite';

const baseTestEnv = Object.assign({}, process.env, {
  PORT: port,
  HOST: testHost,
  TEST_HOST: testHost,
  DB_DIALECT: dbDialect,
  DB_STORAGE: dbStorage,
  DISABLE_NOTIFICATIONS_POLLING: 'true',
  SILENCE_PRETEND_EMAILS: 'true',
  SILENCE_HTTP_LOGS: 'true',
  LOG_LEVEL: 'error',
  // Canonical prefix: the runner must never inject a deprecated name that
  // trips its own deprecation spec (D-19).
  LEAVEPILOT_FEATURES: 'all',
  // The runner IS a test contour: the unsigned-license trust root keys on
  // NODE_ENV === 'test' (WR-01/D-20), and every CI contour that drives this
  // runner already sets NODE_ENV=test. A bare local `node bin/test.js`
  // inherits whatever NODE_ENV the shell has - including none - which
  // rejects the unsigned test-license fixtures and fails the oem/branding
  // suites for a reason that has nothing to do with the code under test.
  NODE_ENV: 'test',
  SE_SKIP_DRIVER_IN_PATH: 'true',
});
const serverEnv = Object.assign({}, baseTestEnv, {
  ALLOW_CREATE_NEW_ACCOUNTS: 'true',
  DISABLE_AUTH_RATE_LIMIT: 'true',
});

/*
  Flake artifact (D-06): every completed run - empty included - leaves a
  flake-report.json at the repo root describing everything this run had to
  retry, from BOTH retry layers:

  - the batch layer, recorded here (one record per integration batch that
    failed its first whole-batch attempt and was re-run);
  - the mocha layer, recorded inside each mocha child by
    t/lib/flake_reporter.js (retry runner events) and flushed to a JSON
    sidecar whose path travels to the child as FLAKE_ARTIFACT_PATH.

  The merge below folds the sidecars into the final report and cleans them
  up. A write failure must never change the run's exit code: the report is a
  diagnostic artifact, not a gate, so it warns and lets the run's own
  verdict stand.

  Every mocha invocation this runner starts carries the flake reporter, so
  skip honesty (D-21) can count distinct skipped spec files from the same
  pending records - one rule (t/lib/skip_honesty.js) for both carriers: this
  runner for runner-driven contours, the require-module for the CI coverage
  contour.
*/
const flakeReportPath = path.join(process.cwd(), 'flake-report.json');

const FLAKE_REPORTER = path.join('t', 'lib', 'flake_reporter.js');

const flaky = [];
const flakeSidecars = [];
let flakeSidecarCounter = 0;

const flakeSidecarPath = contour => {
  flakeSidecarCounter += 1;
  // One sidecar per mocha process; a retried batch reuses its own path so
  // the sidecar always reflects the batch's latest attempt.
  const sidecarPath = path.join(
    process.cwd(),
    `flake-sidecar-${process.pid}-${flakeSidecarCounter}.json`
  );
  flakeSidecars.push({ path: sidecarPath, contour });

  return sidecarPath;
};

const buildFlakeRecords = () => flaky.map(entry => ({
  contour: entry.contour,
  layer: 'batch',
  spec: entry.spec,
  tests: [],
  attempt: 1,
}));

const readFlakeSidecars = () => {
  const mochaRecords = [];
  const skippedSpecFiles = [];

  flakeSidecars.forEach(sidecar => {
    let payload;

    try {
      payload = JSON.parse(fs.readFileSync(sidecar.path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A sidecar killed with its batch (watchdog timeout) or that failed
        // to parse contributes no records rather than failing the report.
        console.warn(`Could not read flake sidecar ${sidecar.path}: ${error.message}`);
      }
      return;
    }

    try {
      fs.unlinkSync(sidecar.path);
    } catch { /* cleanup is best-effort; the file is gitignored */ }

    (payload.retries || []).forEach(entry => mochaRecords.push({
      contour: sidecar.contour,
      layer: 'mocha',
      spec: entry.spec,
      tests: [entry.title],
      attempt: entry.attempt,
      error: entry.error,
    }));

    (payload.pending || []).forEach(entry => skippedSpecFiles.push(entry.spec));
  });

  return { mochaRecords, skippedSpecFiles };
};

const writeFlakeReport = () => new Promise(resolve => {
  const merged = readFlakeSidecars();
  const records = buildFlakeRecords().concat(merged.mochaRecords);

  try {
    fs.writeFileSync(flakeReportPath, JSON.stringify(records, null, 2) + '\n');
  } catch (error) {
    console.warn(`Could not write flake report to ${flakeReportPath}: ${error.message}`);
  }

  // Skip honesty (D-21), runner carrier: the same rule the CI coverage
  // contour loads via --require, fed from the reporter's pending records.
  // Locally a breach warns; only contours that set TEST_ENFORCE_SKIP_HONESTY
  // (CI steps) turn the count into this process exiting non-zero.
  const evaluation = skipHonesty.reportSkipHonesty(merged.skippedSpecFiles);
  if (evaluation.enforce) {
    console.error(skipHonesty.breachMessage(evaluation));
    process.exitCode = 1;
  }

  resolve();
});

/*
  A wedged child is killed rather than waited on. Mocha's own per-test timeout
  cannot always end one: a browser spec that blocks on a socket to chromedriver
  which never answers leaves node with nothing to run, so the timer that would
  have failed the test never fires either. Observed on CI as a mocha process
  that printed its last line and then sat silent for 24 minutes until the job
  timeout killed the whole runner — which loses the other 15 specs in that
  shard and reports nothing about any of them.

  Killing it turns a silent hang into an ordinary batch failure, which the
  retry above already knows how to handle.
*/
const runWithTimeout = (command, args, options = {}, timeoutMs = 0) => new Promise((resolve, reject) => {
  /*
    In its own process group, so that killing it kills what it started. A batch
    is mocha, plus the chromedriver it starts, plus the browser chromedriver
    starts; killing the first of those three leaves the other two running with
    no parent. See bin/lib/spawn_group.js for what that cost.
  */
  const child = spawnInGroup(command, args, Object.assign({
    stdio: 'inherit',
    env: baseTestEnv,
  }, options));

  liveChildren.add(child);

  let timer;
  let timedOut = false;

  const done = () => {
    liveChildren.delete(child);

    if (timer) {
      clearTimeout(timer);
    }
  };

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      console.error(
        `No exit after ${Math.round(timeoutMs / 1000)}s, killing: ${command} ${args.join(' ')}`
      );
      terminateGroup(child);
    }, timeoutMs);
    timer.unref();
  }

  child.on('error', error => {
    done();
    reject(error);
  });

  child.on('exit', code => {
    done();

    /*
      Swept after an ordinary exit too, not only after a kill. A driver.quit()
      that timed out leaves its chromedriver behind, mocha --exit does not wait
      for it, and the group outlives the batch that owned it.
    */
    killGroup(child, 'SIGKILL');

    if (timedOut) {
      reject(new Error(`${command} ${args.join(' ')} hung and was killed`));
      return;
    }

    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
  });
});

const run = (command, args, options = {}) => runWithTimeout(command, args, options, 0);

const collectJavaScriptFiles = directory => fs.readdirSync(directory, {withFileTypes: true})
  .sort((left, right) => left.name.localeCompare(right.name))
  .reduce((files, entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return files.concat(collectJavaScriptFiles(entryPath));
    }
    return entry.isFile() && entry.name.endsWith('.js')
      ? files.concat(entryPath)
      : files;
  }, []);

const quarantine = require('../t/integration_quarantine');

const quarantinedPaths = new Set(
  quarantine.map(entry => path.join('t', 'integration', entry.file))
);

const reportQuarantine = () => {
  if (!quarantine.length) {return;}

  console.log(`Quarantined integration specs (${quarantine.length}), not run:`);
  quarantine.forEach(entry => {
    console.log(`  - t/integration/${entry.file}: ${entry.reason}`);
  });
};

/*
  Every mocha run this file starts loads t/lib/fail_fast, which turns a
  rejection nobody handled into an immediate named failure. Without it those
  land as a bare "Timeout of 120000ms exceeded" and then, often, a process
  that never exits - which costs this runner two 300s watchdog kills before
  it gives up on the batch.
*/
const FAIL_FAST = ['--require', path.join('t', 'lib', 'fail_fast.js')];

const runMochaSuite = () => {
  // Mocha's own --retries repeats a single test inside the process it is
  // already in. Both carriers below read the same TEST_RETRIES knob, so a
  // runner-driven contour - the CI integration shards, the MySQL dialect
  // job - gets the identical retry discipline whether it runs integration
  // batches or an explicit path list (D-04: one policy, no second one).
  const configuredRetries = Number(process.env.TEST_RETRIES);
  const retryArgs = Number.isInteger(configuredRetries) && configuredRetries > 0
    ? ['--retries', String(configuredRetries)]
    : [];

  if (mochaArgs.length) {
    // Paths given on the command line replace the default root rather than
    // adding to it. Passing both meant "one spec" quietly ran the whole tree
    // plus that spec, which is a slow way to learn nothing.
    const explicitPaths = mochaArgs.filter(arg => !arg.startsWith('-'));
    const roots = explicitPaths.length ? explicitPaths : ['t'];
    const flags = mochaArgs.filter(arg => arg.startsWith('-'));

    // One sidecar for the whole explicit run, stable across the retry below:
    // the sidecar always reflects the latest attempt.
    const explicitSidecarPath = flakeSidecarPath('explicit-paths-mocha-retry');

    const mochaExplicit = () => run(
      node,
      ['node_modules/mocha/bin/mocha', '--recursive', '--exit']
        .concat(FAIL_FAST, retryArgs, ['--reporter', FLAKE_REPORTER], roots, flags),
      { env: Object.assign({}, baseTestEnv, { FLAKE_ARTIFACT_PATH: explicitSidecarPath }) }
    );

    // D-04 parity: an explicit-path run gets the same one-retry-per-file
    // discipline the integration batch branch has. Re-running the whole list
    // gives every file a fresh process (and a browser spec its fresh
    // browser), which is the granularity the flake lives at. The retry is
    // named on the console and recorded in the flake report's batch layer -
    // never silent - and a list that fails twice in a row fails the runner.
    return mochaExplicit().catch(error => {
      console.error(`Explicit-path run failed, retrying the whole list: ${error.message}`);
      flaky.push({ contour: 'explicit-paths-batch-retry', spec: roots.join(', ') });
      return mochaExplicit();
    });
  }

  const allIntegrationFiles = collectJavaScriptFiles(path.join('t', 'integration'));
  const unknownQuarantine = Array.from(quarantinedPaths)
    .filter(file => !allIntegrationFiles.includes(file));

  if (unknownQuarantine.length) {
    return Promise.reject(new Error(
      'Quarantine lists specs that do not exist: ' + unknownQuarantine.join(', ')
    ));
  }

  reportQuarantine();

  const selectedFiles = includeQuarantined
    ? allIntegrationFiles
    : allIntegrationFiles.filter(file => !quarantinedPaths.has(file));

  // Deal the files round-robin so every shard gets a mix of fast and slow specs
  // rather than one shard inheriting a whole slow directory.
  const integrationFiles = shard
    ? selectedFiles.filter((_, position) => (position % shard.total) === (shard.index - 1))
    : selectedFiles;

  if (shard) {
    console.log(
      `Shard ${shard.index}/${shard.total}: ${integrationFiles.length}`
      + ` of ${selectedFiles.length} integration specs`
    );
  }
  const configuredBatchSize = Number(process.env.TEST_INTEGRATION_BATCH_SIZE);
  const batchSize = Number.isInteger(configuredBatchSize) && configuredBatchSize > 0
    ? configuredBatchSize
    : 8;
  const batches = [];
  for (let offset = 0; offset < integrationFiles.length; offset += batchSize) {
    batches.push(integrationFiles.slice(offset, offset + batchSize));
  }

  const failures = [];

  // A ceiling on one batch, not on one test. The slowest single file observed
  // takes about 30s, so this is generous by an order of magnitude and only ever
  // fires on a process that has stopped making progress.
  const configuredBatchTimeout = Number(process.env.TEST_BATCH_TIMEOUT_MS);
  const batchTimeoutMs = Number.isInteger(configuredBatchTimeout) && configuredBatchTimeout > 0
    ? configuredBatchTimeout
    : 5 * 60 * 1000;

  /*
    --exit is the other half of the hang.

    Without it mocha waits for the event loop to drain after the last test, so
    one handle nothing closed - a browser session that never quit, a socket to a
    driver that stopped answering - keeps a finished run alive with nothing left
    to print. The premium suite has always passed --exit; this one never did.

    It does not paper over a stuck test: a test that never returns still fails
    on its own timeout, and the batch ceiling above still kills a wedged
    process. This only makes finishing mean exiting.
  */
  const mocha = (batch, sidecarPath) => runWithTimeout(
    node,
    ['node_modules/mocha/bin/mocha', '--exit']
      .concat(FAIL_FAST)
      .concat(retryArgs)
      .concat([
        '--reporter', FLAKE_REPORTER,
        // A2 fallback: if a mocha upgrade ever stops carrying test.file on
        // retry/pending events, the reporter still knows which batch it
        // rendered for.
        '--reporter-option', 'fallbackSpec=' + batch.join(', '),
      ])
      .concat(batch),
    { env: Object.assign({}, baseTestEnv, { FLAKE_ARTIFACT_PATH: sidecarPath }) },
    batchTimeoutMs
  );

  const runBatch = (batch, index) => {
    console.log(`Running integration batch ${index + 1}/${batches.length} (${batch.length} files)`);

    // One sidecar per batch, stable across the retry below: the sidecar
    // always reflects the batch's latest attempt.
    const batchSidecarPath = flakeSidecarPath('integration-mocha-retry');

    // Mocha's own --retries repeats a single test inside the process it is
    // already in, which does not help the failure this suite actually sees:
    // the first test of a file loses its browser and the rest of the file then
    // fails for want of the state it would have created. Every such file
    // passes on its own in a few seconds. Re-running the whole file gives it a
    // fresh browser and a freshly registered company, which is the granularity
    // the flake lives at. Retried files are named at the end of the run: a
    // real regression fails twice and must not hide behind a green tick.
    const attempt = mocha(batch, batchSidecarPath).catch(error => {
      console.error(`Integration batch ${index + 1} failed, retrying the whole batch: ${error.message}`);
      flaky.push({ contour: 'integration-batch-retry', spec: batch.join(', ') });
      return mocha(batch, batchSidecarPath);
    });

    if (!keepGoing) {
      return attempt;
    }

    return attempt.catch(error => {
      console.error(`Integration batch ${index + 1} failed twice: ${error.message}`);
      failures.push(index + 1);
    });
  };

  return batches
    .reduce(
      (sequence, batch, index) => sequence.then(() => runBatch(batch, index)),
      Promise.resolve()
    )
    .then(() => (integrationOnly
      ? null
      : run(
        node,
        ['node_modules/mocha/bin/mocha', '--recursive', '--exit']
          .concat(FAIL_FAST, ['--reporter', FLAKE_REPORTER], ['t/unit']),
        { env: Object.assign({}, baseTestEnv, { FLAKE_ARTIFACT_PATH: flakeSidecarPath('unit-mocha-retry') }) }
      )))
    .then(() => {
      if (flaky.length) {
        console.log(`Spec files that needed a second run (${flaky.length}):`);
        flaky.forEach(entry => console.log(`  - [${entry.contour}] ${entry.spec}`));
      }

      if (failures.length) {
        throw new Error('Integration batches failed: ' + failures.join(', '));
      }
    });
};

const waitForServer = server => new Promise((resolve, reject) => {
  let settled = false;
  const timeout = setTimeout(
    () => finish(new Error(`Timed out waiting for test server at ${host}`)),
    30000
  );
  const onMessage = message => {
    if (message && message.type === 'test-server-ready') {
      finish();
    }
  };
  const onError = error => finish(error);
  const onExit = code => finish(new Error(`Test server exited before readiness with ${code}`));
  const finish = error => {
    if (settled) {return;}
    settled = true;
    clearTimeout(timeout);
    server.removeListener('message', onMessage);
    server.removeListener('error', onError);
    server.removeListener('exit', onExit);
    if (error) {reject(error);}
    else {resolve();}
  };

  server.on('message', onMessage);
  server.on('error', onError);
  server.on('exit', onExit);
});

const stopServer = server => new Promise(resolve => {
  if (!server || server.killed) {
    resolve();
    return;
  }

  server.once('exit', () => resolve());
  server.kill('SIGTERM');
  setTimeout(() => {
    if (!server.killed) {
      server.kill('SIGKILL');
    }
    resolve();
  }, 5000);
});

const rawArgs = process.argv.slice(2).filter(arg => arg !== '--');
// Run only the browser suite: the unit tests already have their own CI job, and
// repeating them here would double a ten-minute run for no extra signal.
const integrationOnly = rawArgs.includes('--integration-only');
/*
  Split the browser suite across several runners. Every hang traced so far ends
  the same way: a poll returns in milliseconds, the next step is scheduled, and
  the process does not get back to it for two minutes. That is a starved
  machine, not a decision any wait makes, so the work is spread instead of being
  packed onto one two-core runner.
*/
const shardArg = rawArgs.find(arg => arg.startsWith('--shard='));
const shard = shardArg
  ? (function(){
      const [index, total] = shardArg.slice('--shard='.length).split('/').map(Number);
      if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
        throw new Error('--shard expects index/total, for example --shard=2/4');
      }
      return {index, total};
    })()
  : null;
// Report every failing batch instead of stopping at the first one. Locally the
// early stop is the faster feedback; on CI one red batch used to hide the rest.
const keepGoing = rawArgs.includes('--keep-going');
// Run the quarantined specs too, to check whether one is ready to come back.
const includeQuarantined = rawArgs.includes('--include-quarantined');
const mochaArgs = rawArgs.filter(arg => ![
  '--integration-only',
  '--keep-going',
  '--include-quarantined',
].includes(arg) && !arg.startsWith('--shard='));

let server;

if (!process.env.KEEP_TEST_DB && fs.existsSync(dbStorage)) {
  fs.unlinkSync(dbStorage);
}

run(node, ['bin/db_update.js'])
  .then(() => {
    server = spawn(node, ['bin/wwww'], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: serverEnv,
    });

    server.on('exit', code => {
      if (code !== null && code !== 0) {
        console.error(`Test server exited with ${code}`);
      }
    });

    return waitForServer(server);
  })
  .then(() => runMochaSuite())
  .then(() => stopServer(server))
  // The flake report is written on the failure path too: a red run is exactly
  // when what got retried matters most, and the CI upload treats a missing
  // file as a defect of its own (if-no-files-found: error).
  .then(() => writeFlakeReport())
  .catch(error => stopServer(server)
    .then(() => writeFlakeReport())
    .then(() => {
      console.error(error && error.stack || error);
      process.exit(1);
    }));
