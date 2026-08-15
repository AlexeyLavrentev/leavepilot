#!/usr/bin/env node

'use strict';

/*
  Install-check runner (INSTALL-01/INSTALL-02; D-01/D-02/D-05/D-06).

  Proves the operator documentation does not lie: the steps this runner
  executes are bash fenced blocks taken from the install docs themselves
  at run time, never copied into any fixture. The scenario map
  (t/fixtures/install-scenario.json) references blocks by
  (doc, heading, per-language blockIndex within that heading) and owns
  the execution ORDER (doc order is not execution order - the
  first-admin section sits above "Обычный запуск" in the doc); the doc
  owns the step CONTENT (D-02). Every expectation - HTTP 302 on the
  root, container/DB/Redis checks, the first-admin redirects - lives
  HERE in the harness, never parsed from doc prose (D-06).

  Only the community sections the scenario maps are executed; blocks
  outside that coverage (commercial, premium scheduler, diagnostics,
  ...) are explicit exclusions in the scenario map with reasons (D-05).

  Scope boundary (D-08): exactly the two install docs -
  docs/docker-compose.md and (from plan 06-02) docs/install-local-npm.md.

  No markdown dependency: the fence scanner below is a hand-rolled
  line walk (research 06-RESEARCH.md §2).

  Usage:
    node bin/install_check.js --slice docker [--doc /path/to/override.md]

  --doc replaces docs/docker-compose.md for every step that references
  it, so negative controls can run against a mutated copy without
  touching the real doc (INSTALL-02 teeth).
*/

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { spawnInGroup, killGroup, terminateGroup } = require('./lib/spawn_group');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_DOC = 'docs/docker-compose.md';
const SCENARIO_PATH = path.join(REPO_ROOT, 't', 'fixtures', 'install-scenario.json');
const DOTENV_PATH = path.join(REPO_ROOT, '.env');

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 240 * 1000;
const HTTP_POLL_INTERVAL_MS = 3000;
const CLEANUP_TIMEOUT_MS = 60 * 1000;

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

function killLiveChildren() {
  liveChildren.forEach(child => killGroup(child, 'SIGKILL'));
  liveChildren.clear();
}

['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    killLiveChildren();
    runPendingCleanupsSync();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
});

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

/*
  Harness-owned readiness wait (D-06): an anonymous GET on the site root
  must answer 302 (redirect to the login page). Everything else - refused
  connections, 5xx from a booting container - keeps polling until the
  ceiling; the compose healthcheck has start_period 15s / interval 30s,
  and first boot runs the migrations.
*/
function waitForHttp302(scenario) {
  const port = (scenario.env.APP_PORT || '3000').trim();
  const url = `http://localhost:${port}/`;
  const ceiling = Number(process.env.INSTALL_CHECK_HTTP_TIMEOUT_MS) || DEFAULT_HTTP_TIMEOUT_MS;
  const deadline = Date.now() + ceiling;
  let attempt = 0;

  console.log(`[harness] waiting for HTTP 302 on ${url} (ceiling ${Math.round(ceiling / 1000)}s)`);

  return (function poll() {
    attempt += 1;
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
  Harness checkpoints (D-06: expectations live here, not in the doc).
  The scenario map names them; the runner defines what they prove.
*/
const harnessCheckpoints = {
  wait_http_302: scenario => waitForHttp302(scenario),
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

function runDocStep(scenario, step, block) {
  const text = blockText(block);
  const label = blockId(step);

  if (!text) {
    throw new Error(`scenario step resolved to an empty fence: ${label}`);
  }

  console.log(`\n[step ${step.number}/${step.total}] ${label} (doc line ${block.line})`);
  text.split('\n').forEach(line => console.log(`    $ ${line}`));

  return runShell(text, scenario.env, stepTimeoutMs());
}

function stepTimeoutMs() {
  return Number(process.env.INSTALL_CHECK_STEP_TIMEOUT_MS) || DEFAULT_STEP_TIMEOUT_MS;
}

function runHarnessStep(scenario, step) {
  const checkpoint = harnessCheckpoints[step.harness];

  if (!checkpoint) {
    throw new Error(`unknown harness checkpoint: ${step.harness}`);
  }

  console.log(`\n[step ${step.number}/${step.total}] [harness] ${step.harness}`);

  return checkpoint(scenario);
}

/*
  The scenario's cleanup steps (role: "cleanup") that have not run yet -
  on a failure or interrupt the stand must still come down through the
  doc's own teardown block, not a hand-rolled command.
*/
function pendingCleanupSteps(scenario) {
  return (scenario.sliceSteps || [])
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

  if (!sliceSteps) {
    console.error(
      `slice "${args.slice}" is not defined in t/fixtures/install-scenario.json`
        + (args.slice === 'npm' ? ' (the npm slice lands with plan 06-02)' : '')
    );
    process.exit(2);
  }

  // Which docs the slice touches; --doc overrides the docker-compose doc
  // in full (negative controls run a mutated copy against every step).
  const docPaths = {};
  sliceSteps.forEach(step => {
    if (step.doc) {
      docPaths[step.doc] = step.doc;
    }
  });
  if (args.doc) {
    if (!('docs/docker-compose.md' in docPaths)) {
      console.error('--doc given but the slice references no docs/docker-compose.md step');
      process.exit(2);
    }
    docPaths['docs/docker-compose.md'] = path.resolve(args.doc);
  }

  const docs = {};
  Object.keys(docPaths).forEach(docRef => {
    const absolute = docRef === 'docs/docker-compose.md' && args.doc
      ? path.resolve(args.doc)
      : path.join(REPO_ROOT, docRef);
    docs[docRef] = collectDocBlocks(absolute);
  });

  const scenario = {
    name: args.slice,
    docs,
    env: Object.assign({}, process.env),
    sliceSteps,
  };

  scenarioState = scenario;

  console.log(`install-check: slice "${args.slice}", ${sliceSteps.length} scenario step(s)`);

  const numbered = sliceSteps.map((step, index) => Object.assign({}, step, {
    number: index + 1,
    total: sliceSteps.length,
    ran: false,
  }));
  scenario.sliceSteps = numbered;
  scenarioState = scenario;

  numbered.reduce(
    (sequence, step) => sequence.then(() => {
      loadDotEnvInto(scenario.env);

      if (step.harness) {
        return runHarnessStep(scenario, step).then(() => { step.ran = true; });
      }

      const block = resolveBlock(scenario, step);
      return runDocStep(scenario, step, block).then(() => { step.ran = true; });
    }),
    Promise.resolve()
  )
    .then(() => {
      const executed = numbered.filter(step => step.ran).length;
      console.log(`\ninstall-check: slice "${args.slice}" passed (${executed} step(s) executed)`);
    })
    .catch(error => runPendingCleanupsAsync()
      .then(() => {
        console.error(`\ninstall-check: slice "${args.slice}" FAILED: ${error.message}`);
        process.exit(1);
      }));
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
