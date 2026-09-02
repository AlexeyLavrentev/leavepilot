#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn} = require('child_process');
const registry = require('../lib/verify/stages');

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
const contained = target => target === artifactBase || target.startsWith(artifactBase + path.sep);
const atomicWrite = (file, value) => {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(temp, value, {mode: 0o600});
  fs.renameSync(temp, file);
};
const runChild = (entry, runRoot) => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(entry.command, entry.args, {cwd: root, env: Object.assign({}, process.env, entry.env || {}), stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
  const timer = setTimeout(() => child.kill('SIGTERM'), entry.deadlineMs);
  child.once('error', error => {
    clearTimeout(timer);
    resolve({id: entry.id, status: 'failed', failureClass: 'runner error', reason: redact(error.message), durationMs: Date.now() - started, attempts: []});
  });
  child.once('exit', code => {
    clearTimeout(timer);
    const timedOut = Date.now() - started >= entry.deadlineMs && code !== 0;
    resolve({id: entry.id, status: code === 0 ? 'passed' : 'failed', failureClass: code === 0 ? null : timedOut ? 'timeout' : 'assertion', reason: code === 0 ? null : `exit ${code}: ${redact(output)}`, durationMs: Date.now() - started, attempts: [{number: 1, status: code === 0 ? 'passed' : 'failed', evidence: path.join(runRoot, `${entry.id}.attempt-1.json`)}]});
  });
});
const checkPrerequisite = entry => new Promise(resolve => {
  if (!entry.prerequisite) { resolve(null); return; }
  const probe = spawn(entry.prerequisite.command, entry.prerequisite.args, {cwd: root, stdio: 'ignore'});
  probe.once('error', () => resolve({id: entry.id, status: 'failed', failureClass: 'missing prerequisite', reason: `Missing prerequisite. Setup: ${entry.prerequisite.setup}`, durationMs: 0, attempts: []}));
  probe.once('exit', code => resolve(code === 0 ? null : {id: entry.id, status: 'failed', failureClass: 'missing prerequisite', reason: `Missing prerequisite. Setup: ${entry.prerequisite.setup}`, durationMs: 0, attempts: []}));
});
const validate = (runRoot, options) => {
  const resolved = path.resolve(runRoot);
  if (!contained(resolved)) { throw new Error('Run root is outside .artifacts/verify'); }
  const summaryPath = path.join(resolved, 'summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  if (summary.schemaVersion !== 1 || !summary.invocationId || !Array.isArray(summary.stages)) { throw new Error('Invalid run summary schema'); }
  if (summary.aggregate !== 'passed' || summary.quarantineCount !== 0 || summary.stages.some(stage => stage.status !== 'passed')) { throw new Error('Run is not complete first-pass-green evidence'); }
  if (options.expectedHead && summary.headSha !== options.expectedHead) { throw new Error('HEAD mismatch'); }
  if (options.startedAfter && Date.parse(summary.startedAt) < Date.parse(options.startedAfter)) { throw new Error('Run is stale'); }
  return summary;
};
const main = async () => {
  let options;
  try { options = parse(process.argv.slice(2)); } catch (error) { usage(error.message); return; }
  try {
    if (options['validate-run-root']) { validate(options['validate-run-root'], options); console.log('Valid authoritative run evidence'); return; }
    if (options['validate-run-path-file']) {
      const pointer = path.resolve(options['validate-run-path-file']);
      const target = fs.readFileSync(pointer, 'utf8').trim();
      validate(target, options); console.log('Valid authoritative run evidence'); return;
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
      const result = prerequisite || await runChild(entry, runRoot);
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
