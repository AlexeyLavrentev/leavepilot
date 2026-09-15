'use strict';

const {isDeepStrictEqual} = require('util');
const {featureFlags, validSnapshot} = require('./stage_diagnostic');

const ORDER = 'runner-selected file order; Mocha declaration order; no randomization';
const expectsTests = entry => entry.id === 'unit-coverage' || entry.args[0] === 'bin/test.js' || entry.id.startsWith('test-diagnostic-');
const effectiveEnv = (entry, env) => ({...env, ...entry.env,
  ...(entry.args[0] === 'bin/test.js' ? {LEAVEPILOT_FEATURES: 'all'} : {}),
});

function createReproduction(entry, env, diagnostics) {
  const effective = effectiveEnv(entry, env);
  return {command: entry.command, args: entry.args, nodeVersion: process.version,
    replay: {command: 'node', args: ['bin/verify.js', '--stage', entry.id]},
    dbContour: entry.env?.TEST_DB_DIALECT === 'mysql' ? 'mysql' : 'sqlite',
    featureFlags: featureFlags(effective),
    shard: entry.args.find(arg => arg.startsWith('--shard='))?.slice(8) || null,
    order: ORDER, seed: null, diagnostics,
  };
}

function validReproduction(repro, entry, identity) {
  const expected = createReproduction(entry, {}, repro.diagnostics);
  if (!isDeepStrictEqual(Object.keys(repro).sort(), Object.keys(expected).sort())
    || !isDeepStrictEqual(repro.replay, expected.replay)
    || repro.shard !== expected.shard || repro.order !== ORDER || repro.seed !== null
    || !isDeepStrictEqual(featureFlags(Object.fromEntries(Object.entries(repro.featureFlags || {}).filter(([, value]) => value !== null))), repro.featureFlags)
    || Object.values(repro.featureFlags).includes('unavailable')) { return false; }
  for (const [key, value] of Object.entries(expected.featureFlags)) {
    if (value !== null && repro.featureFlags[key] !== value) { return false; }
  }
  const diagnostics = repro.diagnostics;
  if (!diagnostics || !isDeepStrictEqual(Object.keys(diagnostics).sort(), ['firstFailure', 'latest'])) { return false; }
  for (const item of Object.values(diagnostics)) {
    if (item?.state === 'unavailable' && Object.keys(item).length === 1) { continue; }
    if (item?.state !== 'received' || !isDeepStrictEqual(Object.keys(item).sort(), ['snapshot', 'state']) || !validSnapshot(item.snapshot, identity)) { return false; }
  }
  if (diagnostics.firstFailure.state !== 'unavailable') { return false; }
  if (!expectsTests(entry)) { return diagnostics.latest.state === 'unavailable'; }
  const snapshot = diagnostics.latest.snapshot;
  return snapshot?.event === 'end' && snapshot.failure === null
    && snapshot.runtime.dbContour === repro.dbContour && snapshot.runtime.nodeVersion === repro.nodeVersion
    && isDeepStrictEqual(snapshot.runtime.featureFlags, repro.featureFlags);
}

module.exports = {createReproduction, validReproduction, expectsTests};
