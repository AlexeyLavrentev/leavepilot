#!/usr/bin/env node

'use strict';

/*
  One-command demo stand (plan 06-03, INSTALL-03; D-09..D-12, D-21).

  `npm run demo` drives the whole lifecycle of a disposable, seeded demo:

    1. reset  - docker compose down -v --remove-orphans (bin/seed_demo.js
                throws when the demo admin email already exists, so a clean
                stand is the idempotency guarantee; the stand is disposable
                by definition, T-06-07 accepted);
    2. up     - docker compose up -d on docker-compose.demo.yml (the
                customer-delivery compose, D-09). On image-pull failure the
                wrapper prints the D-21 pre-tag hint: before the first tag
                the image must be built locally under the same tag;
    3. wait   - HTTP poll of the demo port for the anonymous 302 from /
                (redirect to the login page; bounded loop, the shape
                bin/install_check.js uses for the same boot);
    4. seed   - docker compose exec app node bin/seed_demo.js with the fixed
                demo credentials (D-11/D-12). The seed ships in the runtime
                image via `COPY bin ./bin`; the wrapper never reimplements
                seeding and the image carries no demo logic;
    5. print  - URL, credentials and the teardown command, in Russian
                (owner-facing output; the wrapper itself is a node script
                because bin/test.js is the in-repo orchestrator precedent).

  The demo port is resolved once from DEMO_PORT (default 3001) -
  the exact lever the compose ports mapping ${DEMO_PORT:-3001}:3000
  exposes - and every port-touching step (HTTP poll, printed URL) uses the
  resolved value, so overriding the variable moves the wrapper and the
  mapping together.
*/

const log = require('../lib/middleware/request_logger');

const { spawn } = require('child_process');
const http = require('http');

const COMPOSE_FILE = 'docker-compose.demo.yml';
const DEMO_PORT = String(process.env.DEMO_PORT || '3001').trim();
const DEMO_URL = `http://localhost:${DEMO_PORT}`;

const ADMIN_EMAIL = 'demo-admin@leavepilot.local';
const ADMIN_PASSWORD = 'DemoLeavePilot1!';

const PRETAG_BUILD_HINT = 'docker build --target runtime -t ghcr.io/alexeylavrentev/leavepilot-community:latest .';
const TEARDOWN_COMMAND = `docker compose -f ${COMPOSE_FILE} down -v`;

const HTTP_TIMEOUT_MS = Number(process.env.DEMO_HTTP_TIMEOUT_MS) || 240 * 1000;
const HTTP_POLL_INTERVAL_MS = 3000;

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/*
  The child this wrapper is currently waiting on, so an interrupt does not
  leave a half-finished compose command behind. `up -d` and `exec` are the
  only long ones; killing the wrapper's direct child is enough because the
  compose stack itself is daemonized and reset by the next run's step 1.
*/
let currentChild = null;

/*
  Run one compose command. Resolves {code, output} - the caller decides what
  a failure means - except for a missing docker binary, which no step can
  recover from and which rejects immediately with a plain instruction.
*/
function compose(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', COMPOSE_FILE].concat(args), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentChild = child;

    let output = '';
    const collect = chunk => { output += chunk.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', error => {
      currentChild = null;
      if (error.code === 'ENOENT') {
        reject(new Error('Docker не найден. Установите Docker и запустите `npm run demo` снова.'));
        return;
      }
      reject(error);
    });

    child.on('exit', code => {
      currentChild = null;
      const failed = (code === null ? 1 : code) !== 0;
      // Echo on demand (`options.echo`) but ALWAYS echo a failure's output:
      // compose diagnostics (interpolation errors, pull failures, exec
      // crashes) arrive on the failed command's stdout/stderr, and swallowing
      // them leaves the operator with a generic step message that points at
      // the wrong cause entirely.
      if (output.trim() && (failed || (options && options.echo))) {
        log.info('compose_output', { output: output.trim().split('\n').map(line => '    ' + line).join('\n') });
      }
      resolve({ code: code === null ? 1 : code, output });
    });
  });
}

/*
  Anonymous GET on the site root: resolves the status string ('302', ...), or
  null when the stand does not answer yet (refused connection, booting
  container). Native http keeps the wrapper free of any external binary.
*/
function httpStatus(url) {
  return new Promise(resolve => {
    const request = http.get(url, response => {
      response.resume();
      resolve(String(response.statusCode));
    });
    request.setTimeout(5000, () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

/*
  Readiness wait: the anonymous / must answer 302 (redirect to the login
  page, the same signal bin/install_check.js uses). Everything else - refused
  connections, 5xx from a booting container - keeps polling until the
  ceiling: first boot provisions a fresh MySQL volume and runs migrations.
*/
function waitForDemoStand() {
  const deadline = Date.now() + HTTP_TIMEOUT_MS;
  let attempt = 0;

  log.info('waiting_for_demo_stand', { url: `${DEMO_URL}/` });

  return (function poll() {
    attempt += 1;
    return httpStatus(`${DEMO_URL}/`).then(status => {
      if (status === '302') {
        log.info('demo_stand_ready', { status: '302', attempt });
        return undefined;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Стенд не поднялся за ${Math.round(HTTP_TIMEOUT_MS / 1000)} с (последний ответ: ${status}).`
        );
      }

      if (attempt % 10 === 1) {
        log.info('demo_stand_not_ready', { status, attempt });
      }

      return sleep(HTTP_POLL_INTERVAL_MS).then(poll);
    });
  })();
}

function fail(error) {
  log.error('demo_stand_failed', { error: (error && error.message) || String(error) });
  if (error && error.hint) {
    log.error('demo_hint', { hint: error.hint });
  }
  log.info('demo_cleanup', { msg: 'Сбрасываем то, что успело подняться...' });
  return compose(['down', '-v', '--remove-orphans'])
    .catch(() => {})
    .then(() => { process.exit(1); });
}

['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    if (currentChild) {
      currentChild.kill('SIGKILL');
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
});

log.info('demo_start', { title: 'Демо-стенд LeavePilot' });

Promise.resolve()

  // Step 1: reset. Unconditional so a second `npm run demo` is as green as
  // the first - seed_demo.js throws on an existing admin email, so the
  // wrapper guarantees a clean stand instead (research §8, risk 7).
  .then(() => {
    log.info('demo_step_1', { msg: 'Сбрасываем предыдущий демо-стенд (тома удаляются)...' });
    return compose(['down', '-v', '--remove-orphans']);
  })

  // Step 2: up. A non-zero exit here is most often the pre-tag pull failure
  // (D-21), so the hint names the exact local build command.
  .then(reset => {
    if (reset.code !== 0) {
      throw new Error('Не удалось сбросить предыдущий стенд (docker compose down -v).');
    }

    log.info('demo_step_2', { msg: 'Поднимаем стенд (docker-compose.demo.yml)...' });
    return compose(['up', '-d']).then(up => {
      if (up.code !== 0) {
        const error = new Error('docker compose up не удался.');
        if (/pull|not found|non-distributable|denied|unauthorized/i.test(up.output)) {
          error.hint = 'До первой публикации образа в GHCR соберите его локально тем же тегом:\n    '
            + PRETAG_BUILD_HINT;
        }
        throw error;
      }
      return undefined;
    });
  })

  // Step 3: wait for the anonymous 302.
  .then(() => waitForDemoStand())

  // Step 4: seed from the host wrapper inside the app container (D-11) with
  // the fixed demo credentials (D-12).
  .then(() => {
    log.info('demo_step_4', { msg: 'Наполняем демо-данными («Демо компания»)...' });
    return compose([
      'exec',
      'app',
      'node',
      'bin/seed_demo.js',
      '--email', ADMIN_EMAIL,
      '--password', ADMIN_PASSWORD,
    ], { echo: true });
  })

  .then(seed => {
    if (seed.code !== 0) {
      throw new Error('Наполнение демо-данными не удалось (bin/seed_demo.js).');
    }

    // Step 5: owner-facing summary. RU plain language; identifiers and
    // commands verbatim (D-10/D-12). The teardown command is printed up
    // front - the stand is disposable by definition (T-06-07 accepted).
    log.info('demo_complete', {
      url: DEMO_URL,
      login: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      teardown: TEARDOWN_COMMAND,
    });
    return undefined;
  })

  .catch(fail);
