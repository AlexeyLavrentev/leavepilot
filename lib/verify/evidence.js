'use strict';

const fs = require('fs');
const path = require('path');
const {isDeepStrictEqual} = require('util');
const registry = require('./stages');
const {validateArtifactBundle} = require('./artifact_bundle');
const {validReproduction} = require('./reproduction');
const {readDiagnostics} = require('./stage_diagnostic');

// Aggregate CI coverage keeps its historical meaning: every original full
// stage plus MySQL. Runtime lifecycle stages are accepted evidence inside a
// bundle, but an old bundle never certifies them — the ci-runtime profile has
// to be certified separately through its own expected profile.
const requiredCiStageIds = Object.freeze([...registry.profile('full').stageIds, 'mysql-dialect']);
const allowedStageIds = Object.freeze([...requiredCiStageIds, ...registry.profile('ci-runtime').stageIds]);
// The reproduction contour is derived from the registered stage environment,
// never guessed from the stage id: the runtime matrix exercises both dialects
// internally while its own registered runner contour stays SQLite.
const registeredContour = entry => entry.env && entry.env.TEST_DB_DIALECT === 'mysql' ? 'mysql' : 'sqlite';
const runName = /^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const inside = (base, target) => target === base || target.startsWith(base + path.sep);
const requireTrue = (condition, message) => { if (!condition) { throw new Error(message); } };
const exactKeys = (value, keys) => requireTrue(value && isDeepStrictEqual(Object.keys(value).sort(), keys.slice().sort()), 'Unexpected evidence fields');

function confined(base, target) {
  const resolved = path.resolve(target);
  requireTrue(inside(base, resolved), 'Evidence path is outside .artifacts/verify');
  // Check every component: a lexical prefix alone accepts symlink escapes.
  let current = base;
  for (const part of path.relative(base, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    requireTrue(!fs.lstatSync(current).isSymbolicLink(), 'Evidence symlinks are not allowed');
  }
  requireTrue(inside(fs.realpathSync(base), fs.realpathSync(resolved)), 'Evidence real path escapes its root');
  return resolved;
}

function readJson(base, file) {
  const target = confined(base, file);
  const stat = fs.statSync(target);
  requireTrue(stat.isFile() && stat.size <= 1024 * 1024, 'Evidence must be a bounded JSON file');
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function checkSummary(base, directory, options, requireFull) {
  const summary = readJson(base, path.join(directory, 'summary.json'));
  exactKeys(summary, ['schemaVersion', 'invocationId', 'profile', 'authoritative', 'startedAt', 'headSha', 'source', 'quarantineCount', 'stages', 'aggregate']);
  const identity = path.basename(directory).match(runName);
  requireTrue([2, 3].includes(summary.schemaVersion) && identity && identity[2] === summary.invocationId, 'Invalid run identity or schema');
  requireTrue(Number.isFinite(Date.parse(summary.startedAt)) && Math.abs(Number(identity[1]) - Date.parse(summary.startedAt)) <= 1000, 'Invalid invocation start time');
  requireTrue(/^[0-9a-f]{40}$/.test(summary.headSha), 'Invalid HEAD SHA');
  exactKeys(summary.source, ['start', 'end']);
  for (const snapshot of [summary.source.start, summary.source.end]) {
    exactKeys(snapshot, ['headSha', 'clean']);
    requireTrue(snapshot.clean === true && snapshot.headSha === summary.headSha, 'Source was dirty or changed during verification');
  }
  if (options['expected-head']) {
    requireTrue(summary.headSha === options['expected-head'], 'HEAD mismatch');
  }
  if (options['started-after']) {
    const since = Date.parse(options['started-after']);
    requireTrue(Number.isFinite(since) && Date.parse(summary.startedAt) >= since, 'Run is stale or start constraint is invalid');
  }
  requireTrue(summary.authoritative === true && summary.aggregate === 'passed' && summary.quarantineCount === 0, 'Run is not authoritative first-pass-green evidence');
  requireTrue(Array.isArray(summary.stages) && summary.stages.length > 0, 'Missing stages');
  const ids = summary.stages.map(stage => stage.id);
  requireTrue(ids.every(id => allowedStageIds.includes(id)) && new Set(ids).size === ids.length, 'Unknown or duplicate stages');
  if (requireFull) { requireTrue(summary.profile === 'full', 'Pointer certification requires the full local profile'); }
  if (options['expected-profile']) {
    // An explicit expected profile certifies exactly one named authoritative
    // profile with its complete ordered stage set — nothing looser.
    const expected = registry.profile(options['expected-profile']);
    requireTrue(expected.authoritative, 'Expected profile is not authoritative');
    requireTrue(summary.profile === expected.id, 'Run profile does not match the expected profile');
    requireTrue(isDeepStrictEqual(ids, expected.stageIds), 'Expected profile stages are incomplete or unordered');
  }
  if (summary.profile !== null) {
    const profile = registry.profile(summary.profile);
    requireTrue(profile.authoritative && isDeepStrictEqual(ids, profile.stageIds), 'Incomplete or unordered profile stages');
  } else {
    requireTrue(ids.length === 1, 'A stage invocation must contain exactly one stage');
  }
  for (const stage of summary.stages) {
    exactKeys(stage, ['id', 'status', 'failureClass', 'reason', 'durationMs', 'attempts']);
    requireTrue(stage.status === 'passed' && stage.failureClass === null && stage.reason === null && Number.isFinite(stage.durationMs) && stage.durationMs >= 0, 'Invalid successful stage outcome');
    requireTrue(Array.isArray(stage.attempts) && stage.attempts.length === 1, 'Expected exactly one first-pass attempt');
    const attempt = stage.attempts[0];
    exactKeys(attempt, ['number', 'status', 'evidence', 'reproduction']);
    requireTrue(attempt.number === 1 && attempt.status === 'passed', 'First attempt did not pass');
    const entry = registry.stage(stage.id);
    const repro = attempt.reproduction;
    if (summary.schemaVersion === 2) {
      exactKeys(repro, ['command', 'args', 'nodeVersion', 'dbContour', 'featureFlags']);
      requireTrue(repro.featureFlags === 'not-recorded', 'Invalid historical reproduction metadata');
    } else {
      requireTrue(validReproduction(repro, entry, `${path.basename(directory)}/${entry.id}`), 'Invalid reproduction metadata');
      requireTrue(isDeepStrictEqual(repro.diagnostics, readDiagnostics(path.join(directory, entry.id), `${path.basename(directory)}/${entry.id}`)), 'Stage sidecars do not match reproduction metadata');
    }
    requireTrue(repro && isDeepStrictEqual(repro.args, entry.args) && (repro.command === entry.command || entry.command === process.execPath && path.basename(repro.command || '') === 'node'), 'Unexpected reproduction command');
    requireTrue(/^v22\./.test(repro.nodeVersion) && repro.dbContour === registeredContour(entry), 'Invalid reproduction metadata');
    const filename = `${stage.id}.attempt-1.json`;
    const reference = attempt.evidence;
    // Downloaded artifacts retain the original runner's absolute path. Rebase
    // only an exact run-id/filename pair, never follow an arbitrary stored path.
    requireTrue(typeof reference === 'string' && !reference.split(/[\\/]/).includes('..') && path.basename(reference) === filename && path.basename(path.dirname(reference)) === path.basename(directory), 'Attempt reference escapes its run');
    const record = readJson(base, path.join(directory, filename));
    requireTrue(isDeepStrictEqual(record, stage), 'Attempt contents do not match the summary');
  }
  return summary;
}

function validateRunRoot(root, options = {}, requireFull = false) {
  if (requireFull && options['expected-profile'] && options['expected-profile'] !== 'full') {
    throw new Error('Conflicting expected profile for full certification');
  }
  const base = path.resolve(registry.artifactRoot);
  const directory = confined(base, root);
  validateArtifactBundle(directory);
  if (fs.existsSync(path.join(directory, 'summary.json'))) {
    return checkSummary(base, directory, options, requireFull);
  }
  requireTrue(!requireFull, 'Missing full-run summary');
  // A named expected profile certifies exactly one invocation; an aggregate
  // CI download directory can never stand in for that single summary.
  requireTrue(!options['expected-profile'], 'An expected profile requires a single run summary');
  // CI uploads separate immutable invocations. Do not manufacture a synthetic
  // green summary for their common download directory.
  const summaries = [];
  function visit(current, depth) {
    requireTrue(depth <= 5, 'CI evidence nesting is too deep');
    for (const item of fs.readdirSync(current, {withFileTypes: true})) {
      requireTrue(!item.isSymbolicLink(), 'CI evidence symlinks are not allowed');
      if (!item.isDirectory()) { continue; }
      const child = path.join(current, item.name);
      if (runName.test(item.name)) {
        const summary = readJson(base, path.join(child, 'summary.json'));
        // Unit tests exercise test-* and quick profiles; these are not CI
        // certificates and cannot contribute any required stage coverage.
        if (summary.profile === 'quick' || summary.profile === 'test-graph' || summary.stages?.every(stage => stage.id.startsWith('test-'))) { continue; }
        summaries.push(checkSummary(base, child, options, false));
      } else if (/^\d+$/.test(item.name) || item.name.startsWith('verify-')) {
        visit(child, depth + 1);
      }
    }
  }
  visit(directory, 0);
  requireTrue(summaries.length > 0, 'Missing CI run summaries');
  requireTrue(new Set(summaries.map(summary => summary.headSha)).size === 1, 'Mixed HEAD evidence');
  requireTrue(new Set(summaries.map(summary => summary.invocationId)).size === summaries.length, 'Duplicate invocation evidence');
  const ids = summaries.flatMap(summary => summary.stages.map(stage => stage.id));
  requireTrue(requiredCiStageIds.every(id => ids.includes(id)), 'Incomplete required CI stage coverage');
  for (const id of new Set(ids)) {
    // css-build-diff legitimately appears in both pushed CI bundles; every
    // other present allowed stage must be unambiguous.
    if (id !== 'css-build-diff') { requireTrue(ids.filter(value => value === id).length === 1, 'Ambiguous CI stage evidence'); }
  }
  return summaries;
}

module.exports = {validateRunRoot};
