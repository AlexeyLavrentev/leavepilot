#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn} = require('child_process');
const {spawnInGroup, terminateGroup} = require('./lib/spawn_group');
const registry = require('../lib/verify/stages');
const {validateRunRoot} = require('../lib/verify/evidence');

const root = process.cwd();
const artifactBase = path.resolve(root, registry.artifactRoot);
const usage = message => {
  if (message) { console.error(message); }
  console.error('Usage: node bin/verify.js --profile <full|quick|ci-browser|ci-mysql> | --stage <id> [--run-path-file <path>]');
  process.exitCode = 2;
};
const redact = value => String(value || '').replace(/\b(token|password|secret|authorization|cookie|key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]').slice(-4096);
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
const runChild = (entry, runRoot, canonical) => new Promise(resolve => {
  const started = Date.now();
  const child = spawnInGroup(entry.command, entry.args, {cwd: root, env: Object.assign({}, process.env, entry.env || {}, {
    TEST_CANONICAL_VERIFY: canonical ? 'true' : 'false',
  }), stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  let deadlineExceeded = false;
  let termination = null;
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    termination = terminateGroup(child);
  }, entry.deadlineMs);
  child.once('error', error => {
    clearTimeout(timer);
    resolve({id: entry.id, status: 'failed', failureClass: 'runner error', reason: redact(error.message), durationMs: Date.now() - started, attempts: []});
  });
  child.once('exit', async code => {
    clearTimeout(timer);
    if (termination) {
      await termination;
    }
    const passed = !deadlineExceeded && code === 0;
    resolve({id: entry.id, status: passed ? 'passed' : 'failed', failureClass: passed ? null : deadlineExceeded ? 'timeout' : 'assertion', reason: passed ? null : `exit ${code}: ${redact(output)}`, durationMs: Date.now() - started, attempts: [{number: 1, status: passed ? 'passed' : 'failed', evidence: path.join(runRoot, `${entry.id}.attempt-1.json`), reproduction: {command: entry.command, args: entry.args, nodeVersion: process.version, dbContour: entry.env && entry.env.TEST_DB_DIALECT || 'sqlite', featureFlags: 'not-recorded'}}]});
  });
});
const checkPrerequisite = entry => new Promise(resolve => {
  if (!entry.prerequisite) { resolve(null); return; }
  const probe = spawn(entry.prerequisite.command, entry.prerequisite.args, {cwd: root, stdio: 'ignore'});
  probe.once('error', () => resolve({id: entry.id, status: 'failed', failureClass: 'missing prerequisite', reason: `Missing prerequisite. Setup: ${entry.prerequisite.setup}`, durationMs: 0, attempts: []}));
  probe.once('exit', code => resolve(code === 0 ? null : {id: entry.id, status: 'failed', failureClass: 'missing prerequisite', reason: `Missing prerequisite. Setup: ${entry.prerequisite.setup}`, durationMs: 0, attempts: []}));
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
    const invocationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const runRoot = path.join(artifactBase, `${Date.now()}-${invocationId}`);
    fs.mkdirSync(runRoot, {recursive: true, mode: 0o700});
    const records = [];
    for (const id of stageIds) {
      const entry = registry.stage(id);
      const blocker = entry.dependencies.find(dependency => records.find(record => record.id === dependency && record.status !== 'passed'));
      if (blocker) { records.push({id, status: 'blocked', blocker, failureClass: null, reason: `Blocked by ${blocker}`, durationMs: 0, attempts: []}); continue; }
      const prerequisite = await checkPrerequisite(entry);
      const result = prerequisite || await runChild(entry, runRoot, selected ? selected.authoritative : true);
      if (result.attempts.length) { atomicWrite(result.attempts[0].evidence, JSON.stringify(result, null, 2) + '\n'); }
      records.push(result);
    }
    const summary = {schemaVersion: 1, invocationId, profile: selected && selected.id || null, authoritative: selected ? selected.authoritative : true, startedAt, headSha: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), quarantineCount: 0, stages: records, aggregate: records.every(record => record.status === 'passed') ? 'passed' : 'failed'};
    atomicWrite(path.join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    if (options['run-path-file']) { atomicWrite(path.resolve(options['run-path-file']), `${runRoot}\n`); }
    console.log(`VERIFY_SUMMARY ${JSON.stringify(summary)}`);
    if (summary.aggregate !== 'passed') { process.exitCode = 1; }
  } catch (error) { usage(error.message); }
};
main();
