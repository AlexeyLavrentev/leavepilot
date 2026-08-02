#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const port = process.env.PORT || '3000';
const testHost = process.env.TEST_HOST || '127.0.0.1';
const host = `http://${testHost}:${port}`;
const node = process.execPath;
const dbStorage = process.env.TEST_DB_STORAGE || path.join(process.cwd(), 'db.test.sqlite');
const baseTestEnv = Object.assign({}, process.env, {
  PORT: port,
  HOST: testHost,
  TEST_HOST: testHost,
  DB_DIALECT: 'sqlite',
  DB_STORAGE: dbStorage,
  DISABLE_NOTIFICATIONS_POLLING: 'true',
  SILENCE_PRETEND_EMAILS: 'true',
  SILENCE_HTTP_LOGS: 'true',
  LOG_LEVEL: 'error',
  TIMEOFF_FEATURES: 'all',
  SE_SKIP_DRIVER_IN_PATH: 'true',
});
const serverEnv = Object.assign({}, baseTestEnv, {
  ALLOW_CREATE_NEW_ACCOUNTS: 'true',
  DISABLE_AUTH_RATE_LIMIT: 'true',
});

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, Object.assign({
    stdio: 'inherit',
    env: baseTestEnv,
  }, options));

  child.on('error', reject);
  child.on('exit', code => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
  });
});

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
  if (!quarantine.length) return;

  console.log(`Quarantined integration specs (${quarantine.length}), not run:`);
  quarantine.forEach(entry => {
    console.log(`  - t/integration/${entry.file}: ${entry.reason}`);
  });
};

const runMochaSuite = () => {
  if (mochaArgs.length) {
    return run(node, ['node_modules/mocha/bin/mocha', '--recursive', 't'].concat(mochaArgs));
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

  const integrationFiles = includeQuarantined
    ? allIntegrationFiles
    : allIntegrationFiles.filter(file => !quarantinedPaths.has(file));
  const configuredBatchSize = Number(process.env.TEST_INTEGRATION_BATCH_SIZE);
  const batchSize = Number.isInteger(configuredBatchSize) && configuredBatchSize > 0
    ? configuredBatchSize
    : 8;
  const batches = [];
  for (let offset = 0; offset < integrationFiles.length; offset += batchSize) {
    batches.push(integrationFiles.slice(offset, offset + batchSize));
  }

  const failures = [];

  // Browser specs wait on animations and network, and a shared runner makes
  // those waits tighter than they are on a developer machine. One retry keeps a
  // single missed wait from failing the run without weakening any assertion; a
  // spec that fails twice in a row is reported.
  const configuredRetries = Number(process.env.TEST_RETRIES);
  const retryArgs = Number.isInteger(configuredRetries) && configuredRetries > 0
    ? ['--retries', String(configuredRetries)]
    : [];

  const runBatch = (batch, index) => {
    console.log(`Running integration batch ${index + 1}/${batches.length} (${batch.length} files)`);
    const attempt = run(node, ['node_modules/mocha/bin/mocha'].concat(retryArgs).concat(batch));

    if (!keepGoing) {
      return attempt;
    }

    return attempt.catch(error => {
      console.error(`Integration batch ${index + 1} failed: ${error.message}`);
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
      : run(node, ['node_modules/mocha/bin/mocha', '--recursive', 't/unit'])))
    .then(() => {
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
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    server.removeListener('message', onMessage);
    server.removeListener('error', onError);
    server.removeListener('exit', onExit);
    if (error) reject(error);
    else resolve();
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
// Report every failing batch instead of stopping at the first one. Locally the
// early stop is the faster feedback; on CI one red batch used to hide the rest.
const keepGoing = rawArgs.includes('--keep-going');
// Run the quarantined specs too, to check whether one is ready to come back.
const includeQuarantined = rawArgs.includes('--include-quarantined');
const mochaArgs = rawArgs.filter(arg => ![
  '--integration-only',
  '--keep-going',
  '--include-quarantined',
].includes(arg));

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
  .catch(error => stopServer(server).then(() => {
    console.error(error && error.stack || error);
    process.exit(1);
  }));
