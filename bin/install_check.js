#!/usr/bin/env node

'use strict';

/*
  Install-check runner (INSTALL-01/INSTALL-02; D-01/D-02/D-03/D-05/D-06).

  Proves the operator documentation does not lie: the steps this runner
  executes are bash fenced blocks taken from the install docs themselves
  at run time, never copied into any fixture. The scenario map
  (t/fixtures/install-scenario.json) references blocks by
  (doc, heading, per-language blockIndex within that heading) and owns
  the execution ORDER (doc order is not execution order - the
  first-admin section sits above "Обычный запуск" in the doc); the doc
  owns the step CONTENT (D-02). Every expectation - HTTP 302 on the
  root, the MySQL dialect, the Redis PONG, the first-admin and login
  redirect targets - lives HERE in the harness, never parsed from doc
  prose (D-06).

  Drift detection is expectCommand pinning: every scenario step carries
  the exact command literal the step exists to run, and the runner
  refuses to execute a resolved block whose content is empty or does
  not contain that literal (INSTALL-02) - an index-shifted or gutted
  doc block fails the run naming the step and the missing literal
  instead of executing silently.

  The D-03 depth: boot from doc blocks, then the first-admin path at
  the doc's stated depth - toggle allow_create_new_accounts in
  config/app.redis.json ON THE HOST (the file is mounted read-only into
  the container and read once at boot, so the toggle precedes the
  container start, exactly as the doc's own step order prescribes),
  register the first company through the real form (session cookie +
  the route-local CSRF token - a bare POST is bounced), revert, run the
  doc's restart-app block, then log in for real. The config revert runs
  on every exit path (failure and interrupt included), so a red run
  never leaves registration open.

  Only the community sections the scenario maps are executed; blocks
  outside that coverage (commercial, premium scheduler, diagnostics,
  ...) are explicit exclusions in the scenario map with reasons (D-05).
  The npm slice (06-02, D-07) runs the variant-A fast subset of
  docs/install-local-npm.md: install -> migrate -> background boot ->
  readiness -> the SQLite dialect check -> background stop.

  Scope boundary (D-08): exactly the two install docs -
  docs/docker-compose.md and docs/install-local-npm.md.

  No markdown dependency: the fence scanner below is a hand-rolled
  line walk (research 06-RESEARCH.md §2).

  Usage:
    node bin/install_check.js --slice docker [--doc /path/to/override.md]
    node bin/install_check.js --slice npm   [--doc /path/to/override.md]

  --doc substitutes the slice's referenced install doc with a mutated
  copy for negative controls (a slice maps exactly one doc today), so a
  gutted doc block can be proven to fail the run without touching the
  real doc (INSTALL-02 teeth).
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { spawnInGroup, killGroup, terminateGroup } = require('./lib/spawn_group');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_DOC = 'docs/docker-compose.md';
const SCENARIO_PATH = path.join(REPO_ROOT, 't', 'fixtures', 'install-scenario.json');
const DOTENV_PATH = path.join(REPO_ROOT, '.env');
const APP_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'app.redis.json');

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 240 * 1000;
const HTTP_POLL_INTERVAL_MS = 3000;
const CLEANUP_TIMEOUT_MS = 60 * 1000;

// The first-admin identity the harness registers through the real
// form. Each run starts from disposable volumes (the scenario's
// down -v teardown), so the fixed values never collide with leftovers.
const ADMIN = {
  email: 'install-check@example.com',
  password: 'install-check-admin-pass',
  name: 'Install',
  lastname: 'Check',
  company_name: 'Install Check Company',
  country: 'GB',
  timezone: 'Europe/London',
};

/*
  Fence scanner. An opening fence is three or more backticks or tildes
  followed by a language tag; a closing fence is the marker alone. Block
  identity is (heading text, language, blockIndex) where blockIndex counts
  fences of the SAME language inside the SAME heading section - adding a
  ```text or ```json fence to a section cannot renumber its bash blocks.
*/
const FENCE_OPEN = /^(`{3,}|~{3,})(\S*)\s*$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

function parseDocFences(source) {
  const blocks = [];
  const perHeadingLang = new Map();
  let heading = '';
  let open = null;

  source.split('\n').forEach((line, index) => {
    if (open) {
      if (FENCE_CLOSE.test(line)) {
        blocks.push({
          heading,
          lang: open.lang,
          blockIndex: open.blockIndex,
          line: open.line,
          lines: open.lines,
        });
        open = null;
      } else {
        open.lines.push(line);
      }
      return;
    }

    const headingMatch = HEADING.exec(line);
    if (headingMatch) {
      heading = headingMatch[2].trim();
      return;
    }

    const fenceMatch = FENCE_OPEN.exec(line);
    if (fenceMatch) {
      const lang = fenceMatch[2] || '';
      const key = heading + '\u0000' + lang;
      const blockIndex = perHeadingLang.get(key) || 0;
      perHeadingLang.set(key, blockIndex + 1);
      open = { lang, blockIndex, line: index + 1, lines: [] };
    }
  });

  if (open) {
    throw new Error(
      `unclosed fence opened at line ${open.line} of the parsed doc (heading "${heading}")`
    );
  }

  return blocks;
}

function collectDocBlocks(docPath) {
  return parseDocFences(fs.readFileSync(docPath, 'utf8'));
}

function blockText(block) {
  return block.lines.join('\n').trim();
}

function blockId(step) {
  return `${step.doc} :: "${step.heading}" :: bash#${step.blockIndex}`;
}

/*
  Minimal .env reader for the doc blocks that expand host-shell variables
  (the MySQL verification block runs `mysql -uroot -p"$MYSQL_ROOT_PASSWORD"`).
  The doc tells the operator to put these values into .env; the runner
  makes them visible to the blocks the same way an operator's exported
  shell would. Quotes are stripped, comments ignored.
*/
function parseDotEnv(source) {
  const map = {};

  source.split('\n').forEach(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      return;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) {
      return;
    }

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (value.length > 1
        && ((value.startsWith('"') && value.endsWith('"'))
          || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    map[key] = value;
  });

  return map;
}

function loadDotEnvInto(env) {
  if (!fs.existsSync(DOTENV_PATH)) {
    return;
  }

  Object.assign(env, parseDotEnv(fs.readFileSync(DOTENV_PATH, 'utf8')));
}

/*
  Host-side config toggle for the first-admin flow (T-06-02): the
  original bytes are snapshotted before the first edit and restored on
  every exit path - failure, interrupt and success alike - so a red run
  never leaves allow_create_new_accounts open. The replacement touches
  only the one value, keeping every other byte (key alignment included)
  intact; restore is the snapshot verbatim.
*/
let configSnapshot = null;

function toggleAllowCreateNewAccounts(enabled) {
  const current = fs.readFileSync(APP_CONFIG_PATH, 'utf8');

  if (configSnapshot === null) {
    configSnapshot = current;
  }

  const pattern = /("allow_create_new_accounts"\s*:\s*)(true|false)/;
  if (!pattern.test(current)) {
    throw new Error(
      `cannot toggle allow_create_new_accounts: pattern not found in ${APP_CONFIG_PATH}`
    );
  }

  fs.writeFileSync(
    APP_CONFIG_PATH,
    current.replace(pattern, (match, prefix) => prefix + String(enabled))
  );

  console.log(`[harness] config: allow_create_new_accounts -> ${enabled} (host-side, ${APP_CONFIG_PATH})`);
}

function restoreAppConfig() {
  if (configSnapshot === null) {
    return;
  }

  fs.writeFileSync(APP_CONFIG_PATH, configSnapshot);
  configSnapshot = null;
  console.log('[harness] config revert: allow_create_new_accounts -> false (original bytes restored)');
}

/*
  Every batch this runner has going, so an interrupt can take the tools a
  doc step started with it (same discipline as bin/test.js). Note that
  `docker compose up -d` services belong to the daemon, not to this
  process tree: on interrupt and on failure the runner additionally runs
  the scenario's pending cleanup block(s) - the doc's own
  `docker compose down -v` - so a red or interrupted run never leaks the
  stand it brought up.
*/
const liveChildren = new Set();
let scenarioState = null;
let cookieJarPath = null;

/*
  Steps the doc starts as a server (the npm slice's `npm start`): the
  block must keep running while the scenario proceeds, so the runner
  spawns it in its own group (it joins liveChildren - the interrupt
  path kills it with everything else), does NOT wait for its exit, and
  records how it ended so the readiness wait can fail fast when the
  server died instead of burning its whole ceiling on a refused port.
*/
const backgroundSteps = [];

function runShellBackground(commandText, env) {
  const child = spawnInGroup('/bin/bash', ['-c', commandText], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });

  const record = { child, exited: null };
  backgroundSteps.push(record);
  liveChildren.add(child);

  child.on('exit', code => {
    record.exited = code === null ? 'signal' : code;
    liveChildren.delete(child);
  });

  return Promise.resolve();
}

/*
  Group teardown for the background steps: the server the doc started
  must not outlive the run. SIGTERM first (the app's runtime shutdown
  closes the db handle), SIGKILL after the grace period - the same
  discipline bin/test.js applies to its batches. Called as the scenario's
  own last step (the harness checkpoint below) and again on the runner's
  success exit; the failure and interrupt paths take the synchronous
  SIGKILL sweep instead, because a red run must not hang on a server
  that ignores polite signals.
*/
function stopBackgroundSteps() {
  const running = backgroundSteps.filter(record => record.exited === null);

  if (!running.length) {
    if (backgroundSteps.length) {
      console.log('[harness] background steps: already exited, nothing to stop');
    }
    return Promise.resolve();
  }

  return running.reduce(
    (sequence, record) => sequence.then(() => {
      console.log(`[harness] stopping background step (pid ${record.child.pid})`);
      return terminateGroup(record.child).then(() => {
        record.exited = 'stopped';
        liveChildren.delete(record.child);
      });
    }),
    Promise.resolve()
  );
}

function killLiveChildren() {
  liveChildren.forEach(child => killGroup(child, 'SIGKILL'));
  liveChildren.clear();
}

function removeCookieJar() {
  if (cookieJarPath) {
    try { fs.unlinkSync(cookieJarPath); } catch (absent) { /* best-effort */ }
    cookieJarPath = null;
  }
}

['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    killLiveChildren();
    restoreAppConfig();
    removeCookieJar();
    runPendingCleanupsSync();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
});

function stepTimeoutMs() {
  return Number(process.env.INSTALL_CHECK_STEP_TIMEOUT_MS) || DEFAULT_STEP_TIMEOUT_MS;
}

function runShell(commandText, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnInGroup('/bin/bash', ['-c', commandText], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    });

    liveChildren.add(child);

    let timedOut = false;
    let timer;

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
          `No exit after ${Math.round(timeoutMs / 1000)}s, killing: ${commandText.split('\n')[0]}`
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
      // Sweep the group after an ordinary exit too (bin/test.js discipline):
      // a helper a block started must never outlive the block.
      killGroup(child, 'SIGKILL');

      if (timedOut) {
        reject(new Error(`step hung and was killed: ${commandText.split('\n')[0]}`));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`step exited with ${code}: ${commandText.split('\n')[0]}`));
    });
  });
}

/*
  Capturing variant for steps whose output the harness asserts on (the
  MySQL dialect and Redis PONG blocks). Output is echoed to the console
  after completion so the run log still shows what the doc block
  produced, then handed to the step's output assert.
*/
function runShellCapture(commandText, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnInGroup('/bin/bash', ['-c', commandText], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    liveChildren.add(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer;

    const done = () => {
      liveChildren.delete(child);
      if (timer) {
        clearTimeout(timer);
      }
    };

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
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
      killGroup(child, 'SIGKILL');

      if (timedOut) {
        reject(new Error(`step hung and was killed: ${commandText.split('\n')[0]}`));
        return;
      }

      resolve({ code, stdout, stderr });
    });
  });
}

function httpStatusCode(url) {
  return new Promise(resolve => {
    const child = spawn(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', url],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );

    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => resolve(null));
    child.on('exit', () => resolve(out.trim() || null));
  });
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function baseUrl(scenario) {
  // The two install docs name the port differently: the compose doc's
  // .env carries APP_PORT, the npm doc's «Порт» section says the app
  // takes PORT when set and 3000 otherwise (bin/wwww reads the same
  // variable). APP_PORT wins so a compose environment is never
  // misread, then PORT, then the shared default.
  const port = (scenario.env.APP_PORT || scenario.env.PORT || '3000').trim();
  return `http://localhost:${port}`;
}

/*
  Harness-owned readiness wait (D-06): an anonymous GET on the site root
  must answer 302 (redirect to the login page). Everything else - refused
  connections, 5xx from a booting container - keeps polling until the
  ceiling; the compose healthcheck has start_period 15s / interval 30s,
  and first boot runs the migrations. One fail-fast: a background step
  that already exited non-zero means the server the doc started is dead -
  polling a corpse for the whole ceiling turns a clear crash into a
  confusing timeout, so the wait rejects naming the exit code.
*/
function waitForHttp302(scenario) {
  const url = `${baseUrl(scenario)}/`;
  const ceiling = Number(process.env.INSTALL_CHECK_HTTP_TIMEOUT_MS) || DEFAULT_HTTP_TIMEOUT_MS;
  const deadline = Date.now() + ceiling;
  let attempt = 0;

  console.log(`[harness] waiting for HTTP 302 on ${url} (ceiling ${Math.round(ceiling / 1000)}s)`);

  return (function poll() {
    attempt += 1;

    const crashed = backgroundSteps.find(record =>
      typeof record.exited === 'number' && record.exited !== 0
    );
    if (crashed) {
      return Promise.reject(
        new Error(
          `a background step exited with ${crashed.exited} before the site answered`
            + ` - the server the doc started died (its output is above)`
        )
      );
    }

    return httpStatusCode(url).then(status => {
      if (status === '302') {
        console.log(`[harness] HTTP 302 on ${url} after ${attempt} attempt(s)`);
        return Promise.resolve();
      }

      if (Date.now() >= deadline) {
        return Promise.reject(
          new Error(`timed out waiting for HTTP 302 on ${url} (last status: ${status})`)
        );
      }

      if (attempt % 10 === 1) {
        console.log(`[harness] not ready yet (status: ${status}), attempt ${attempt}`);
      }

      return sleep(HTTP_POLL_INTERVAL_MS).then(poll);
    });
  })();
}

/*
  First-admin HTTP plumbing (D-03). /register/ and /login/ carry their
  own route-local CSRF verifier (lib/middleware/auth_security.js,
  mounted in lib/route/login.js): a bare POST is redirected back to the
  form. So every form POST is preceded by a GET with the same cookie
  jar - the session it creates is what holds csrf_token, and the
  hidden _csrf input of the rendered form is the matching token.
*/
function ensureCookieJar() {
  if (!cookieJarPath) {
    cookieJarPath = path.join(os.tmpdir(), `install-check-jar-${process.pid}.txt`);
  }
  return cookieJarPath;
}

function curlGet(url) {
  return new Promise(resolve => {
    const child = spawn('curl', ['-s', '-c', ensureCookieJar(), '--max-time', '15', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', () => resolve(null));
    child.on('exit', () => resolve(stdout));
  });
}

/*
  Returns { status, redirectUrl } - the HTTP status and the resolved
  Location target of the response (curl does not follow it).
*/
function curlPostForm(url, fields) {
  const args = ['-s', '-b', ensureCookieJar(), '-c', ensureCookieJar(),
    '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', '--max-time', '15'];

  Object.keys(fields).forEach(key => {
    args.push('--data-urlencode', `${key}=${fields[key]}`);
  });
  args.push(url);

  return new Promise(resolve => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'] });

    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => resolve({ status: null, redirectUrl: '' }));
    child.on('exit', () => {
      const parts = out.trim().split(/\s+/, 2);
      resolve({ status: parts[0] || null, redirectUrl: parts[1] || '' });
    });
  });
}

function extractCsrfToken(html) {
  const match = /name="_csrf"\s+value="([^"]+)"/.exec(html || '');
  return match ? match[1] : null;
}

function redirectPathname(redirectUrl) {
  if (!redirectUrl) {
    return null;
  }

  try {
    return new URL(redirectUrl).pathname;
  } catch (error) {
    return redirectUrl;
  }
}

function logFlashContext(pathname) {
  // Best-effort flash-error context for a failed form POST: fetch the
  // page the app bounced to (same session) and surface its alert text.
  return curlGet(`${baseUrl(scenarioState)}${pathname}`).then(html => {
    const alerts = (html || '').match(/class="[^"]*alert[^"]*"[^>]*>([\s\S]{0,300}?)</g) || [];
    if (alerts.length) {
      console.error(`[harness] flash context from ${pathname}:`);
      alerts.slice(0, 3).forEach(alert => {
        console.error(`[harness]   ${alert.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
      });
    }
  }).catch(() => {});
}

/*
  Success and failure of the register POST are told apart by the
  redirect TARGET, not by the 302 status: validation failure bounces
  back to /register/ (lib/route/login.js), success lands on the site
  root /. Same contract for /login/.
*/
function assertFormRedirect(result, failurePathname, label) {
  const target = redirectPathname(result.redirectUrl);

  if (result.status === '302' && target === '/') {
    console.log(`[harness] ${label}: 302 -> Location target "/" (success)`);
    return Promise.resolve();
  }

  return logFlashContext(failurePathname).then(() => {
    throw new Error(
      `${label} failed: status ${result.status}, Location target ${JSON.stringify(target)}`
        + ` - expected 302 with target "/" (a target of ${JSON.stringify(failurePathname)}`
        + ` means the form bounced back: validation or CSRF failure)`
    );
  });
}

function registerFirstAdmin() {
  const url = `${baseUrl(scenarioState)}/register/`;

  console.log(`[harness] first admin: GET ${url} (session + _csrf)`);

  return curlGet(url).then(html => {
    const token = extractCsrfToken(html);

    if (!token) {
      throw new Error(
        `first admin: GET ${url} returned no _csrf hidden field`
          + ' - either the page is not the register form (is allow_create_new_accounts'
          + ' toggled on and the container started after the toggle?) or the route changed'
      );
    }

    console.log(`[harness] first admin: POST ${url} (company "${ADMIN.company_name}", fields + _csrf)`);

    return curlPostForm(url, {
      _csrf: token,
      email: ADMIN.email,
      name: ADMIN.name,
      lastname: ADMIN.lastname,
      company_name: ADMIN.company_name,
      password: ADMIN.password,
      password_confirmed: ADMIN.password,
      country: ADMIN.country,
      timezone: ADMIN.timezone,
    });
  }).then(result => assertFormRedirect(result, '/register/', 'first admin: POST /register/'));
}

function loginFirstAdmin() {
  const url = `${baseUrl(scenarioState)}/login/`;

  console.log(`[harness] login: GET ${url} (fresh session + fresh _csrf)`);

  return curlGet(url).then(html => {
    const token = extractCsrfToken(html);

    if (!token) {
      throw new Error(`login: GET ${url} returned no _csrf hidden field`);
    }

    console.log(`[harness] login: POST ${url} (${ADMIN.email} + _csrf)`);

    return curlPostForm(url, {
      _csrf: token,
      email: ADMIN.email,
      password: ADMIN.password,
    });
  }).then(result => assertFormRedirect(result, '/login/', 'login: POST /login/'));
}

/*
  Output asserts (D-06: expectations live in the harness). The scenario
  map names them per step; these predicates define what they prove over
  the captured block output.
*/
const outputAsserts = {
  mysql_dialect: output => {
    if (!/mysql/.test(output)) {
      throw new Error(`MySQL dialect check: block output did not contain "mysql" (got: ${output.trim().slice(0, 200)})`);
    }
    console.log('[harness] MySQL dialect check: output contains "mysql"');
  },
  sqlite_dialect: output => {
    if (!/sqlite/.test(output)) {
      throw new Error(`SQLite dialect check: block output did not contain "sqlite" (got: ${output.trim().slice(0, 200)})`);
    }
    console.log('[harness] SQLite dialect check: output contains "sqlite"');
  },
  redis_pong: output => {
    if (!/PONG/.test(output)) {
      throw new Error(`Redis ping: block output did not contain PONG (got: ${output.trim().slice(0, 200)})`);
    }
    console.log('[harness] Redis ping: output contains PONG');
  },
};

/*
  Harness checkpoints (D-06: expectations live here, not in the doc).
  The scenario map names them; the runner defines what they prove.
*/
const harnessCheckpoints = {
  wait_http_302: scenario => waitForHttp302(scenario),
  allow_create_new_accounts_on: () => toggleAllowCreateNewAccounts(true),
  allow_create_new_accounts_off: () => restoreAppConfig(),
  register_first_admin: () => registerFirstAdmin(),
  login_first_admin: () => loginFirstAdmin(),
  stop_background_steps: () => stopBackgroundSteps(),
};

function resolveBlock(scenario, step) {
  const blocks = scenario.docs[step.doc];
  const candidates = (blocks || []).filter(block =>
    block.heading === step.heading
    && block.lang === 'bash'
    && block.blockIndex === step.blockIndex
  );

  if (!candidates.length) {
    throw new Error(
      `scenario step resolves to no bash fence: ${blockId(step)}`
        + ` - the doc block was removed, renamed, or reindexed (INSTALL-02)`
    );
  }

  return candidates[0];
}

/*
  expectCommand pinning (INSTALL-02 teeth): the block content must be
  non-empty AND contain the literal command the step exists to run
  before anything executes. The error names the step's heading +
  blockIndex and the missing literal, so an empty-but-resolvable block
  or an index-shifted wrong block can never execute silently.
*/
function pinExpectedCommand(step, text) {
  if (!text || text.indexOf(step.expectCommand) === -1) {
    throw new Error(
      `doc drift (INSTALL-02): ${blockId(step)} does not contain the expected command literal`
        + ` ${JSON.stringify(step.expectCommand)}`
        + (text ? '' : ' (the resolved block is EMPTY)')
        + ' - the doc block was gutted or the scenario points at the wrong fence'
    );
  }
}

function runDocStep(scenario, step, block) {
  const text = blockText(block);
  const label = blockId(step);

  pinExpectedCommand(step, text);

  console.log(`\n[step ${step.number}/${step.total}] ${label} (doc line ${block.line})`);
  text.split('\n').forEach(line => console.log(`    $ ${line}`));

  const outputAssert = step.harnessAssert ? outputAsserts[step.harnessAssert] : null;

  if (step.harnessAssert && !outputAssert) {
    throw new Error(`unknown output assert: ${step.harnessAssert}`);
  }

  // A background step (await:false) is a server the doc starts: spawn it
  // in its own group, do not wait for it, and let the readiness
  // checkpoint decide when it is up. The drift pin above still applies -
  // a gutted boot block fails before anything spawns - and the started
  // group joins the kill set, so the server cannot outlive the run.
  if (step.await === false) {
    if (outputAssert) {
      throw new Error(`a background step (await:false) cannot carry an output assert: ${label}`);
    }
    return runShellBackground(text, scenario.env);
  }

  if (outputAssert) {
    return runShellCapture(text, scenario.env, stepTimeoutMs()).then(result => {
      const output = `${result.stdout}\n${result.stderr}`;

      // Echo the captured output BEFORE judging the exit code, so a
      // failing block leaves its own error text in the run log.
      output.split('\n').filter(Boolean).forEach(line => console.log(`    > ${line}`));

      if (result.code !== 0) {
        throw new Error(`step exited with ${result.code}: ${text.split('\n')[0]}`);
      }

      outputAssert(output);
    });
  }

  return runShell(text, scenario.env, stepTimeoutMs());
}

function runHarnessStep(scenario, step) {
  const checkpoint = harnessCheckpoints[step.harness];

  if (!checkpoint) {
    throw new Error(`unknown harness checkpoint: ${step.harness}`);
  }

  console.log(`\n[step ${step.number}/${step.total}] [harness] ${step.harness}`);

  // Checkpoints may be plain synchronous actions (the config toggle);
  // normalize so the sequential runner always chains a promise.
  const result = checkpoint(scenario);
  return result && typeof result.then === 'function' ? result : Promise.resolve();
}

/*
  The scenario's cleanup steps (role: "cleanup") that have not run yet -
  on a failure or interrupt the stand must still come down through the
  doc's own teardown block, not a hand-rolled command.
*/
function pendingCleanupSteps(scenario) {
  return ((scenario && scenario.sliceSteps) || [])
    .filter(step => step.doc && step.role === 'cleanup' && !step.ran);
}

function runPendingCleanupsSync() {
  if (!scenarioState) {
    return;
  }

  pendingCleanupSteps(scenarioState).forEach(step => {
    try {
      const block = resolveBlock(scenarioState, step);
      const text = blockText(block);
      console.error(`[cleanup] running teardown block: ${blockId(step)}`);
      require('child_process').spawnSync('/bin/bash', ['-c', text], {
        cwd: REPO_ROOT,
        env: scenarioState.env,
        stdio: 'inherit',
        timeout: CLEANUP_TIMEOUT_MS,
      });
      step.ran = true;
    } catch (error) {
      console.error(`[cleanup] teardown failed for ${blockId(step)}: ${error.message}`);
    }
  });
}

function runPendingCleanupsAsync() {
  const steps = pendingCleanupSteps(scenarioState || {});

  if (!steps.length) {
    return Promise.resolve();
  }

  return steps.reduce(
    (sequence, step) => sequence.then(() => {
      const block = resolveBlock(scenarioState, step);
      console.error(`[cleanup] running teardown block: ${blockId(step)}`);
      return runShell(blockText(block), scenarioState.env, CLEANUP_TIMEOUT_MS)
        .then(() => { step.ran = true; })
        .catch(error => {
          console.error(`[cleanup] teardown failed for ${blockId(step)}: ${error.message}`);
        });
    }),
    Promise.resolve()
  );
}

function parseArgs(argv) {
  const args = { slice: null, doc: null };
  const errors = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--slice') {
      args.slice = argv[++i];
      if (!args.slice) {
        errors.push('--slice expects a slice name (docker, npm)');
      }
    } else if (arg.startsWith('--slice=')) {
      args.slice = arg.slice('--slice='.length);
    } else if (arg === '--doc') {
      args.doc = argv[++i];
      if (!args.doc) {
        errors.push('--doc expects a file path');
      }
    } else if (arg.startsWith('--doc=')) {
      args.doc = arg.slice('--doc='.length);
    } else {
      errors.push(`unknown argument: ${arg}`);
    }
  }

  if (!args.slice) {
    errors.push('--slice is required (docker, npm)');
  }

  if (errors.length) {
    errors.forEach(error => console.error(error));
    console.error('usage: node bin/install_check.js --slice <name> [--doc <path>]');
    process.exit(2);
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarioMap = JSON.parse(fs.readFileSync(SCENARIO_PATH, 'utf8'));
  const sliceSteps = (scenarioMap.slices || {})[args.slice];
  const sliceOptions = (scenarioMap.sliceOptions || {})[args.slice] || {};

  if (!sliceSteps) {
    console.error(
      `slice "${args.slice}" is not defined in t/fixtures/install-scenario.json`
    );
    process.exit(2);
  }

  // Which docs the slice touches, resolved to readable paths. --doc
  // substitutes the slice's single referenced install doc with a mutated
  // copy (negative controls, INSTALL-02 teeth): a slice maps exactly one
  // doc today, so the substitution is unambiguous - a future multi-doc
  // slice must grow an explicit selector instead of guessing here.
  const docPaths = {};
  sliceSteps.forEach(step => {
    if (step.doc) {
      docPaths[step.doc] = path.join(REPO_ROOT, step.doc);
    }
  });

  if (args.doc) {
    const referenced = Object.keys(docPaths);
    if (referenced.length !== 1) {
      console.error(
        `--doc given but the slice references ${referenced.length} doc(s) - the substitution is ambiguous`
      );
      process.exit(2);
    }
    docPaths[referenced[0]] = path.resolve(args.doc);
  }

  const docs = {};
  Object.keys(docPaths).forEach(docRef => {
    docs[docRef] = collectDocBlocks(docPaths[docRef]);
  });

  const numbered = sliceSteps.map((step, index) => Object.assign({}, step, {
    number: index + 1,
    total: sliceSteps.length,
    ran: false,
  }));

  const scenario = {
    name: args.slice,
    docs,
    env: Object.assign({}, process.env),
    sliceSteps: numbered,
  };

  scenarioState = scenario;

  console.log(`install-check: slice "${args.slice}", ${numbered.length} scenario step(s)`);

  numbered.reduce(
    (sequence, step) => sequence.then(() => {
      // .env is operator context for the compose doc: its MySQL
      // verification block expands MYSQL_ROOT_PASSWORD from it. The npm
      // doc's variant A assumes a clean shell - and the compose .env
      // carries DB_DIALECT=mysql, which would steer db-update and the
      // dialect check off SQLite - so the npm slice opts out
      // (sliceOptions.loadDotEnv: false).
      if (sliceOptions.loadDotEnv !== false) {
        loadDotEnvInto(scenario.env);
      }

      if (step.harness) {
        return runHarnessStep(scenario, step).then(() => { step.ran = true; });
      }

      const block = resolveBlock(scenario, step);
      return runDocStep(scenario, step, block).then(() => { step.ran = true; });
    }),
    Promise.resolve()
  )
    .then(() => stopBackgroundSteps())
    .then(() => {
      restoreAppConfig();
      removeCookieJar();
      // Sweep after the graceful stop too: the scenario's own stop step
      // (or stopBackgroundSteps above) is the intended path, but a
      // helper any block started must never outlive the run.
      killLiveChildren();
      const executed = numbered.filter(step => step.ran).length;
      console.log(`\ninstall-check: slice "${args.slice}" passed (${executed} step(s) executed)`);
    })
    .catch(error => {
      // A red run takes the synchronous sweep, not the graceful stop:
      // it must not hang on a server that ignores polite signals.
      killLiveChildren();
      try {
        restoreAppConfig();
      } catch (restoreError) {
        console.error(`[cleanup] config revert failed: ${restoreError.message}`);
      }
      removeCookieJar();
      return runPendingCleanupsAsync().then(() => {
        console.error(`\ninstall-check: slice "${args.slice}" FAILED: ${error.message}`);
        process.exit(1);
      });
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_DOC,
  collectDocBlocks,
  parseDocFences,
  parseDotEnv,
};
