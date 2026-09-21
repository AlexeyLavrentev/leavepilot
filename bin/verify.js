#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {spawnInGroup, terminateGroup, terminateTree} = require('./lib/spawn_group');
const registry = require('../lib/verify/stages');
const {validateRunRoot} = require('../lib/verify/evidence');
const redactDiagnosticText = require('../lib/verify/diagnostic_text');
const createChildOutput = require('../lib/verify/child_output');
const {readDiagnostics} = require('../lib/verify/stage_diagnostic');
const {createReproduction, validReproduction} = require('../lib/verify/reproduction');

const root = process.cwd();
const artifactBase = path.resolve(root, registry.artifactRoot);
let interruptedSignal = null;
let stopActive = null;
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    interruptedSignal = interruptedSignal || signal;
    if (stopActive) { stopActive(); }
  });
});
const usage = message => {
  if (message) { console.error(message); }
  console.error('Usage: node bin/verify.js --profile <full|quick|ci-browser|ci-mysql> | --stage <id> [--run-path-file <path>]');
  process.exitCode = 2;
};
const redact = value => redactDiagnosticText(value).slice(-4096);
const sourceState = () => {
  const git = args => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    return {headSha: git(['rev-parse', 'HEAD']), clean: git(['status', '--porcelain=v1', '--untracked-files=normal']) === ''};
  } catch {
    // Git diagnostics can contain local paths/configuration. Fail closed without
    // persisting them or pretending an unknown checkout is a clean revision.
    throw new Error('Cannot establish Git source provenance');
  }
};
const parse = argv => {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--profile', '--stage', '--run-path-file', '--validate-run-root', '--validate-run-path-file', '--expected-head', '--started-after'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) { throw new Error(`Missing value for ${arg}`); }
    result[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
};
const atomicWrite = (file, value) => {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(temp, value, {mode: 0o600});
  fs.renameSync(temp, file);
};
const sweepExited = async child => {
  const outcome = await terminateGroup(child, {graceMs: 0});
  return outcome.termSent || outcome.errors.length
    ? {processes: [], groups: [{pid: child.pid, ...outcome}], snapshotError: null}
    : null;
};
const runChild = (entry, runRoot, canonical, deadlineAt, prerequisite = false) => new Promise(resolve => {
  const started = Date.now();
  const execution = prerequisite ? entry.prerequisite : entry;
  const diagnosticPrefix = path.join(runRoot, entry.id);
  const diagnosticIdentity = `${path.basename(runRoot)}/${entry.id}`;
  const child = spawnInGroup(execution.command, execution.args, {cwd: root, env: Object.assign({}, process.env, prerequisite ? {} : entry.env || {}, {
    TEST_CANONICAL_VERIFY: canonical ? 'true' : 'false',
    TEST_VERIFY_DIAGNOSTIC_PREFIX: diagnosticPrefix,
    TEST_VERIFY_DIAGNOSTIC_ID: diagnosticIdentity,
  }), stdio: ['ignore', 'pipe', 'pipe']});
  const output = createChildOutput({
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  });
  const record = (passed, failureClass, reason, reproduction, outcome) => {
    const result = {id: entry.id, status: passed ? 'passed' : 'failed', failureClass, reason,
      durationMs: Date.now() - started,
      attempts: [{number: 1, status: passed ? 'passed' : 'failed',
        evidence: path.join(runRoot, `${entry.id}.attempt-1.json`), reproduction}],
    };
    if (!passed) {
      // This is an invocation attempt, not a claim that a test ran. Keep the
      // failed prerequisite/spawn distinct from the intended stage replay.
      result.execution = {phase: prerequisite ? 'prerequisite' : 'stage', command: execution.command,
        args: execution.args, started: Boolean(child.pid)};
    }
    if (outcome) { result.termination = outcome; }
    return result;
  };
  const reproduction = () => createReproduction(entry, process.env, readDiagnostics(diagnosticPrefix, diagnosticIdentity));
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  let deadlineExceeded = false;
  let termination = null;
  stopActive = () => {
    if (!termination) { termination = terminateTree(child); }
    return termination;
  };
  child.stdout.on('data', chunk => output.write('stdout', chunk));
  child.stderr.on('data', chunk => output.write('stderr', chunk));
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    stopActive();
    // An escaped descendant holding a pipe cannot extend the stage deadline.
    child.stdout.destroy();
    child.stderr.destroy();
  }, Math.max(0, deadlineAt - Date.now()));
  child.once('error', error => {
    clearTimeout(timer);
    stopActive = null;
    output.end();
    resolve(record(false, prerequisite ? 'missing prerequisite' : 'runner error',
      redact(`${prerequisite ? `Missing prerequisite. Setup: ${execution.setup}; ` : ''}${error.message}`), reproduction()));
  });
  child.once('exit', async code => {
    let outcome = termination ? await termination : await sweepExited(child);
    // exit can precede the final pipe data. Sweep first (descendants may own
    // pipes), then wait for EOF under the same stage deadline before recording.
    await closed;
    if (termination) {outcome = await termination;}
    clearTimeout(timer);
    output.end();
    stopActive = null;
    const repro = reproduction();
    const diagnosticValid = prerequisite || validReproduction(repro, entry, diagnosticIdentity);
    const passed = !outcome && !deadlineExceeded && !interruptedSignal && code === 0 && diagnosticValid;
    const failureClass = passed ? null : interruptedSignal ? 'runner error' : deadlineExceeded ? 'timeout'
      : outcome || (code === 0 && !diagnosticValid) ? 'runner error' : prerequisite ? 'missing prerequisite' : 'assertion';
    const reason = passed ? null : `${prerequisite ? `${deadlineExceeded ? 'Prerequisite exceeded stage deadline' : 'Missing prerequisite'}. Setup: ${execution.setup}; ` : ''}${interruptedSignal ? `Interrupted by ${interruptedSignal}; ` : ''}${outcome && !termination ? 'Surviving process group after stage exit; ' : ''}${code === 0 && !diagnosticValid ? 'Missing or invalid stage completion diagnostics; ' : ''}exit ${code}: ${redact(output.tail())}`;
    resolve(record(passed, failureClass, reason, repro, outcome));
  });
});
const checkPrerequisite = async (entry, runRoot, canonical, deadlineAt) => {
  if (!entry.prerequisite) { return null; }
  const result = await runChild(entry, runRoot, canonical, deadlineAt, true);
  return result.status === 'passed' ? null : result;
};
const main = async () => {
  let options;
  try { options = parse(process.argv.slice(2)); } catch (error) { usage(error.message); return; }
  try {
    if (options['validate-run-root']) { validateRunRoot(options['validate-run-root'], options); console.log('Valid authoritative run evidence'); return; }
    if (options['validate-run-path-file']) {
      const pointer = path.resolve(options['validate-run-path-file']);
      const target = fs.readFileSync(pointer, 'utf8').trim();
      if (!path.isAbsolute(target)) { throw new Error('Run pointer must be absolute'); }
      validateRunRoot(target, options, true); console.log('Valid authoritative run evidence'); return;
    }
    if ((options.profile && options.stage) || (!options.profile && !options.stage)) { usage('Choose exactly one profile or stage'); return; }
    const selected = options.profile ? registry.profile(options.profile) : null;
    const stageIds = selected ? selected.stageIds : [registry.stage(options.stage).id];
    const sourceStart = sourceState();
    const invocationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const runRoot = path.join(artifactBase, `${Date.now()}-${invocationId}`);
    fs.mkdirSync(runRoot, {recursive: true, mode: 0o700});
    // A killed invocation must not leave a pointer to a previous green run.
    // An incomplete new directory fails certification until its summary exists.
    if (options['run-path-file']) { atomicWrite(path.resolve(options['run-path-file']), `${runRoot}\n`); }
    const records = [];
    for (const id of stageIds) {
      if (interruptedSignal) {
        records.push({id, status: 'blocked', failureClass: null, reason: `Interrupted by ${interruptedSignal}`, durationMs: 0, attempts: []});
        continue;
      }
      const entry = registry.stage(id);
      const stageStartedAt = Date.now();
      const deadlineAt = stageStartedAt + entry.deadlineMs;
      const blocker = entry.dependencies.find(dependency => records.find(record => record.id === dependency && record.status !== 'passed'));
      if (blocker) { records.push({id, status: 'blocked', blocker, failureClass: null, reason: `Blocked by ${blocker}`, durationMs: 0, attempts: []}); continue; }
      const canonical = selected ? selected.authoritative : true;
      const prerequisite = await checkPrerequisite(entry, runRoot, canonical, deadlineAt);
      const result = prerequisite || await runChild(entry, runRoot, canonical, deadlineAt);
      result.durationMs = Date.now() - stageStartedAt;
      if (result.attempts.length) { atomicWrite(result.attempts[0].evidence, JSON.stringify(result, null, 2) + '\n'); }
      records.push(result);
    }
    const sourceEnd = sourceState();
    // These boundary checks require exclusive workspace ownership during a run;
    // they cannot observe transient edits reverted before the final snapshot.
    const stableSource = sourceStart.clean && sourceEnd.clean && sourceStart.headSha === sourceEnd.headSha;
    const summary = {schemaVersion: 3, invocationId, profile: selected && selected.id || null, authoritative: (selected ? selected.authoritative : true) && stableSource, startedAt, headSha: sourceStart.headSha, source: {start: sourceStart, end: sourceEnd}, quarantineCount: 0, stages: records, aggregate: records.every(record => record.status === 'passed') ? 'passed' : 'failed'};
    atomicWrite(path.join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`VERIFY_SUMMARY ${JSON.stringify(summary)}`);
    if (!stableSource) { process.stderr.write('Development result only: source was dirty or changed during verification; not certifiable.\n'); }
    if (summary.aggregate !== 'passed') { process.exitCode = interruptedSignal === 'SIGINT' ? 130 : interruptedSignal ? 143 : 1; }
  } catch (error) { usage(error.message); }
};
main();
