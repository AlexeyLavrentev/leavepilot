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
const runChild = (entry, runRoot, canonical, deadlineAt) => new Promise(resolve => {
  const started = Date.now();
  const child = spawnInGroup(entry.command, entry.args, {cwd: root, env: Object.assign({}, process.env, entry.env || {}, {
    TEST_CANONICAL_VERIFY: canonical ? 'true' : 'false',
  }), stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  let deadlineExceeded = false;
  let termination = null;
  stopActive = () => {
    if (!termination) { termination = terminateTree(child); }
    return termination;
  };
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    stopActive();
  }, Math.max(0, deadlineAt - Date.now()));
  child.once('error', error => {
    clearTimeout(timer);
    stopActive = null;
    resolve({id: entry.id, status: 'failed', failureClass: 'runner error', reason: redact(error.message), durationMs: Date.now() - started, attempts: []});
  });
  child.once('exit', async code => {
    clearTimeout(timer);
    const outcome = termination ? await termination : await sweepExited(child);
    stopActive = null;
    const passed = !outcome && !deadlineExceeded && !interruptedSignal && code === 0;
    const result = {id: entry.id, status: passed ? 'passed' : 'failed', failureClass: passed ? null : interruptedSignal ? 'runner error' : deadlineExceeded ? 'timeout' : outcome ? 'runner error' : 'assertion', reason: passed ? null : `${interruptedSignal ? `Interrupted by ${interruptedSignal}; ` : ''}${outcome && !termination ? 'Surviving process group after stage exit; ' : ''}exit ${code}: ${redact(output)}`, durationMs: Date.now() - started, attempts: [{number: 1, status: passed ? 'passed' : 'failed', evidence: path.join(runRoot, `${entry.id}.attempt-1.json`), reproduction: {command: entry.command, args: entry.args, nodeVersion: process.version, dbContour: entry.env && entry.env.TEST_DB_DIALECT || 'sqlite', featureFlags: 'not-recorded'}}]};
    if (outcome) { result.termination = outcome; }
    resolve(result);
  });
});
const checkPrerequisite = (entry, deadlineAt) => new Promise(resolve => {
  if (!entry.prerequisite) { resolve(null); return; }
  const started = Date.now();
  const probe = spawnInGroup(entry.prerequisite.command, entry.prerequisite.args, {cwd: root, stdio: 'ignore'});
  let termination;
  stopActive = () => {
    if (!termination) { termination = terminateTree(probe); }
    return termination;
  };
  const failure = (failureClass, reason) => ({id: entry.id, status: 'failed', failureClass, reason, durationMs: Date.now() - started, attempts: []});
  const timer = setTimeout(() => {
    stopActive();
  }, Math.max(0, deadlineAt - Date.now()));
  probe.once('error', () => {
    clearTimeout(timer);
    stopActive = null;
    resolve(failure('missing prerequisite', `Missing prerequisite. Setup: ${entry.prerequisite.setup}`));
  });
  probe.once('exit', async code => {
    clearTimeout(timer);
    if (termination) {
      const outcome = await termination;
      stopActive = null;
      resolve({...failure(interruptedSignal ? 'runner error' : 'timeout', interruptedSignal ? `Interrupted by ${interruptedSignal}` : `Prerequisite exceeded stage deadline. Setup: ${entry.prerequisite.setup}`), termination: outcome});
      return;
    }
    const outcome = await sweepExited(probe);
    stopActive = null;
    if (outcome) {
      resolve({...failure('runner error', 'Surviving process group after prerequisite exit'), termination: outcome});
      return;
    }
    resolve(code === 0 ? null : failure('missing prerequisite', `Missing prerequisite. Setup: ${entry.prerequisite.setup}`));
  });
});
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
      const prerequisite = await checkPrerequisite(entry, deadlineAt);
      const result = prerequisite || await runChild(entry, runRoot, selected ? selected.authoritative : true, deadlineAt);
      result.durationMs = Date.now() - stageStartedAt;
      if (result.attempts.length) { atomicWrite(result.attempts[0].evidence, JSON.stringify(result, null, 2) + '\n'); }
      records.push(result);
    }
    const sourceEnd = sourceState();
    // These boundary checks require exclusive workspace ownership during a run;
    // they cannot observe transient edits reverted before the final snapshot.
    const stableSource = sourceStart.clean && sourceEnd.clean && sourceStart.headSha === sourceEnd.headSha;
    const summary = {schemaVersion: 2, invocationId, profile: selected && selected.id || null, authoritative: (selected ? selected.authoritative : true) && stableSource, startedAt, headSha: sourceStart.headSha, source: {start: sourceStart, end: sourceEnd}, quarantineCount: 0, stages: records, aggregate: records.every(record => record.status === 'passed') ? 'passed' : 'failed'};
    atomicWrite(path.join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    if (options['run-path-file']) { atomicWrite(path.resolve(options['run-path-file']), `${runRoot}\n`); }
    console.log(`VERIFY_SUMMARY ${JSON.stringify(summary)}`);
    if (!stableSource) { process.stderr.write('Development result only: source was dirty or changed during verification; not certifiable.\n'); }
    if (summary.aggregate !== 'passed') { process.exitCode = interruptedSignal === 'SIGINT' ? 130 : interruptedSignal ? 143 : 1; }
  } catch (error) { usage(error.message); }
};
main();
