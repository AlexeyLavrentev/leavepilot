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
// Phase-final invocations (plan 08-2): each named certification owns exactly
// one invocation record and pointer directly under the artifact root, so a
// final gate can never be confused with the reusable legacy pairs above.
const NAMED_CERTIFICATIONS = Object.freeze({
  'phase02-final-local': Object.freeze({profile: 'full'}),
  'phase02-final-mysql': Object.freeze({profile: 'ci-mysql'}),
  'phase02-final-runtime': Object.freeze({profile: 'ci-runtime'}),
});
const METADATA_KEYS = Object.freeze(['expectedHead', 'expectedProfile', 'name', 'pointer', 'schemaVersion', 'startedAfter']);
const MAX_METADATA_BYTES = 4096;
// Validation only reads bounded evidence; a generous finite cap keeps even a
// hung validator from certifying indefinitely.
const VALIDATION_TIMEOUT_MS = 30000;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/*
  Certification records live beside the run evidence they bind. The evidence
  regression suite (t/unit/verify/evidence.js) drives these same functions and
  would otherwise read, overwrite or delete the real records — including while
  a full-profile certification is executing its unit stage in this same
  workspace. TEST_CERTIFY_ROOT is a test-only containment override with no
  operator-facing effect: it is set exclusively by that suite around its own
  captures, so production and CI invocations always use the artifact root.
*/
const certificationBaseDir = () => process.env.TEST_CERTIFY_ROOT
  ? path.resolve(process.env.TEST_CERTIFY_ROOT)
  : path.join(root, registry.artifactRoot);
const certificationDir = () => path.join(certificationBaseDir(), 'certify');
const pointerFile = name => path.join(certificationDir(), `${name}.path`);
const metadataFile = name => path.join(certificationDir(), `${name}.json`);
const namedPointerFile = name => path.join(certificationBaseDir(), `${name}.path`);
const namedMetadataFile = name => path.join(certificationBaseDir(), `${name}.invocation.json`);

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
  A slot is the one place every certification path resolves to: the fixed
  name/profile pair plus the exact metadata and pointer files it owns. Legacy
  pairs live under certify/; phase-final named pairs live directly under the
  artifact root. Nothing else in the helper branches on which form was used.
*/
function legacySlot(profile) {
  const pair = pairFor(profile);
  return {name: pair.name, profile,
    metadataFile: metadataFile(pair.name), pointerFile: pointerFile(pair.name)};
}

function namedSlot(name, profile) {
  const pair = NAMED_CERTIFICATIONS[name];
  requireCondition(pair, `Unsupported named certification: ${name}`);
  requireCondition(pair.profile === profile, `Named certification ${name} is not bound to profile ${profile}`);
  requireCondition(registry.profile(profile).authoritative, `Profile is not authoritative: ${profile}`);
  return {name, profile,
    metadataFile: namedMetadataFile(name), pointerFile: namedPointerFile(name)};
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

async function runForSlot(slot, spawnChild = runBoundedChild) {
  const {profile} = slot;
  const head = boundedHead();
  const pointer = slot.pointerFile;
  const startedAfter = new Date().toISOString();
  // Clear only this certification's own pointer first: a killed child must not
  // leave a previous green run behind as certifiable, and no other profile's
  // pointer is touched. The identity is captured atomically immediately before
  // the child starts, binding the evidence to this exact invocation.
  atomicWrite(pointer, '');
  atomicWrite(slot.metadataFile, `${JSON.stringify({schemaVersion: 1, name: slot.name, expectedProfile: profile, expectedHead: head, startedAfter, pointer}, null, 2)}\n`);
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

async function validateForSlot(slot, spawnChild = runBoundedChild) {
  const file = slot.metadataFile;
  const stat = fs.statSync(file);
  requireCondition(stat.isFile() && stat.size <= MAX_METADATA_BYTES, 'Invalid certification metadata file');
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Exact bounded shape, fixed pair and fixed pointer path: nothing saved by a
  // different profile or pointed elsewhere can certify this invocation.
  requireCondition(isDeepStrictEqual(Object.keys(metadata).sort(), [...METADATA_KEYS].sort()), 'Unexpected certification metadata fields');
  requireCondition(metadata.schemaVersion === 1, 'Unsupported certification metadata schema');
  requireCondition(metadata.name === slot.name && metadata.expectedProfile === slot.profile, 'Certification name/profile pair mismatch');
  requireCondition(metadata.pointer === slot.pointerFile, 'Certification pointer path mismatch');
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

const runCertification = (profile, spawnChild) => runForSlot(legacySlot(profile), spawnChild);
const validateCertification = (profile, spawnChild) => validateForSlot(legacySlot(profile), spawnChild);
const runNamedCertification = (name, profile, spawnChild) => runForSlot(namedSlot(name, profile), spawnChild);
const validateNamedCertification = (name, profile, spawnChild) => validateForSlot(namedSlot(name, profile), spawnChild);

module.exports = {CERTIFICATIONS, NAMED_CERTIFICATIONS, metadataFile, pointerFile,
  namedMetadataFile, namedPointerFile, runCertification, validateCertification,
  runNamedCertification, validateNamedCertification};

if (require.main === module) {
  const usage = 'Usage: node t/fixtures/verify/certify_profile.js (--run|--validate) <full|ci-mysql|ci-runtime>\n'
    + '       node t/fixtures/verify/certify_profile.js (--run|--validate) --name <phase02-final-local|phase02-final-mysql|phase02-final-runtime> --profile <full|ci-mysql|ci-runtime>';
  const argv = process.argv.slice(2);
  // Exactly one of the two legal forms; everything else fails closed so no
  // invocation can claim a pair it did not name explicitly.
  const positional = argv.length === 2 && ['--run', '--validate'].includes(argv[0])
    ? {mode: argv[0], profile: argv[1]} : null;
  const flagged = argv.length === 5 && ['--run', '--validate'].includes(argv[0])
    && argv[1] === '--name' && argv[3] === '--profile'
    ? {mode: argv[0], name: argv[2], profile: argv[4]} : null;
  const request = positional || flagged;
  if (!request || (flagged && !NAMED_CERTIFICATIONS[flagged.name])) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    (async () => {
      try {
        const outcome = request.name
          ? request.mode === '--run'
            ? await runNamedCertification(request.name, request.profile)
            : await validateNamedCertification(request.name, request.profile)
          : request.mode === '--run'
            ? await runCertification(request.profile)
            : await validateCertification(request.profile);
        if (outcome.reason) { console.error(outcome.reason); }
        process.exitCode = outcome.code;
      } catch (error) { console.error(error.message); process.exitCode = 2; }
    })();
  }
}
