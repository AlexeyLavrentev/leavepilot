#!/usr/bin/env node
'use strict';

/*
  Certify one authoritative profile from the exact invocation that produced it.

  `--run` captures the invocation identity (HEAD, profile, start time, pointer)
  immediately before spawning the real verifier child, so the child's evidence
  can never predate the invocation that claims it. `--validate` later hands the
  saved identity to bin/verify.js and proves the retained evidence belongs to
  that invocation and no earlier green run. The helper never provisions
  services, never retries a failed child and never certifies an old pointer.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {isDeepStrictEqual} = require('util');
const {spawnInGroup, terminateTree, DEFAULT_GRACE_MS} = require('../../../bin/lib/spawn_group');
const registry = require('../../../lib/verify/stages');

const root = path.resolve(__dirname, '../../..');
// Fixed name/profile pairs only: each certifiable profile owns exactly one
// pointer and one metadata file, and validation never accepts another pair.
const CERTIFICATIONS = Object.freeze({
  full: Object.freeze({name: 'local-full'}),
  'ci-mysql': Object.freeze({name: 'real-mysql'}),
  'ci-runtime': Object.freeze({name: 'real-runtime'}),
});
const METADATA_KEYS = Object.freeze(['expectedHead', 'expectedProfile', 'name', 'pointer', 'schemaVersion', 'startedAfter']);
const MAX_METADATA_BYTES = 4096;
// Validation only reads bounded evidence; a generous finite cap keeps even a
// hung validator from certifying indefinitely.
const VALIDATION_TIMEOUT_MS = 30000;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const certificationDir = () => path.join(root, registry.artifactRoot, 'certify');
const pointerFile = name => path.join(certificationDir(), `${name}.path`);
const metadataFile = name => path.join(certificationDir(), `${name}.json`);

const requireCondition = (condition, message) => { if (!condition) { throw new Error(message); } };

const atomicWrite = (file, value) => {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(temp, value, {mode: 0o600});
  fs.renameSync(temp, file);
};

const boundedHead = () => {
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], {
      cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Git diagnostics can carry local paths/configuration; fail closed instead
    // of pretending an unknown checkout is the certified revision.
    throw new Error('Cannot establish Git source provenance');
  }
};

function pairFor(profile) {
  const pair = CERTIFICATIONS[profile];
  requireCondition(pair, `Unsupported certification profile: ${profile}`);
  requireCondition(registry.profile(profile).authoritative, `Profile is not authoritative: ${profile}`);
  return pair;
}

/*
  One bounded child in its own process group: Ctrl-C no longer reaches a
  detached child, so signals are forwarded through the shared tree termination,
  and the finite timeout converts a hung child into a nonzero outcome instead
  of an unbounded wait.
*/
function runBoundedChild(execution, timeoutMs) {
  return new Promise(resolve => {
    const child = spawnInGroup(execution.command, execution.args, {cwd: root, stdio: 'inherit'});
    let interrupted = null;
    let timedOut = false;
    let termination = null;
    const stop = () => {
      if (!termination) { termination = terminateTree(child); }
      return termination;
    };
    const onSignal = signal => { interrupted = interrupted || signal; stop(); };
    const detach = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(0, timeoutMs));
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    child.once('error', error => {
      detach();
      resolve({code: 1, reason: `Cannot start ${execution.command}: ${error.message}`});
    });
    child.once('exit', async code => {
      if (termination) { await termination; }
      detach();
      const reason = timedOut ? `Certification invocation exceeded its ${timeoutMs} ms budget`
        : interrupted ? `Interrupted by ${interrupted}` : null;
      resolve({code: interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : timedOut ? 124 : code, reason});
    });
  });
}

async function runCertification(profile, spawnChild = runBoundedChild) {
  const pair = pairFor(profile);
  const head = boundedHead();
  const pointer = pointerFile(pair.name);
  const startedAfter = new Date().toISOString();
  // Clear only this certification's own pointer first: a killed child must not
  // leave a previous green run behind as certifiable, and no other profile's
  // pointer is touched. The identity is captured atomically immediately before
  // the child starts, binding the evidence to this exact invocation.
  atomicWrite(pointer, '');
  atomicWrite(metadataFile(pair.name), `${JSON.stringify({schemaVersion: 1, name: pair.name, expectedProfile: profile, expectedHead: head, startedAfter, pointer}, null, 2)}\n`);
  // Finite overall budget: every selected stage deadline plus the shared
  // cleanup grace the child's own sweeps may still need after the last stage.
  const budgetMs = registry.profile(profile).stageIds.reduce((total, id) => total + registry.stage(id).deadlineMs, 0)
    + 2 * DEFAULT_GRACE_MS;
  const execution = profile === 'full'
    ? {command: npm, args: ['run', 'verify', '--', '--run-path-file', pointer]}
    : {command: process.execPath, args: ['bin/verify.js', '--profile', profile, '--run-path-file', pointer]};
  const outcome = await spawnChild(execution, budgetMs);
  // A failed child keeps its invocation metadata for diagnosis; this helper
  // never certifies an earlier pointer and never retries on its own.
  return outcome;
}

async function validateCertification(profile, spawnChild = runBoundedChild) {
  const pair = pairFor(profile);
  const file = metadataFile(pair.name);
  const stat = fs.statSync(file);
  requireCondition(stat.isFile() && stat.size <= MAX_METADATA_BYTES, 'Invalid certification metadata file');
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Exact bounded shape, fixed pair and fixed pointer path: nothing saved by a
  // different profile or pointed elsewhere can certify this invocation.
  requireCondition(isDeepStrictEqual(Object.keys(metadata).sort(), [...METADATA_KEYS].sort()), 'Unexpected certification metadata fields');
  requireCondition(metadata.schemaVersion === 1, 'Unsupported certification metadata schema');
  requireCondition(metadata.name === pair.name && metadata.expectedProfile === profile, 'Certification name/profile pair mismatch');
  requireCondition(metadata.pointer === pointerFile(pair.name), 'Certification pointer path mismatch');
  requireCondition(/^[0-9a-f]{40}$/.test(metadata.expectedHead), 'Invalid certification HEAD');
  requireCondition(Number.isFinite(Date.parse(metadata.startedAfter)), 'Invalid certification start time');
  const head = boundedHead();
  requireCondition(head === metadata.expectedHead, 'Current HEAD does not match the certified invocation');
  const pointerTarget = fs.readFileSync(metadata.pointer, 'utf8').trim();
  requireCondition(path.isAbsolute(pointerTarget), 'Run pointer must be absolute');
  // The saved start time is reused as-is: validation must read the original
  // invocation's timestamp, never generate a fresh one. The pointer file — not
  // a resolved run directory — crosses into bin/verify.js so the validator
  // stays the single reader of pointer contents.
  return spawnChild({
    command: process.execPath,
    args: ['bin/verify.js', '--validate-run-path-file', metadata.pointer,
      '--expected-head', metadata.expectedHead,
      '--expected-profile', metadata.expectedProfile,
      '--started-after', metadata.startedAfter],
  }, VALIDATION_TIMEOUT_MS);
}

module.exports = {CERTIFICATIONS, metadataFile, pointerFile, runCertification, validateCertification};

if (require.main === module) {
  const usage = 'Usage: node t/fixtures/verify/certify_profile.js (--run|--validate) <full|ci-mysql|ci-runtime>';
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || !['--run', '--validate'].includes(argv[0])) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    (async () => {
      try {
        const outcome = argv[0] === '--run' ? await runCertification(argv[1]) : await validateCertification(argv[1]);
        if (outcome.reason) { console.error(outcome.reason); }
        process.exitCode = outcome.code;
      } catch (error) { console.error(error.message); process.exitCode = 2; }
    })();
  }
}
