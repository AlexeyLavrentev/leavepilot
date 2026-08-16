'use strict';

// Generation env resolver: resolves environment variables by ordered generation
// so a prefix rename (TIMEOFF_ → LEAVEPILOT_) is a config-only upgrade for
// existing deployments, and warns once at boot about deprecated generation-1
// names still set in the environment. This module is the single read site for
// TIMEOFF_/LEAVEPILOT_ names (via resolve) and BRAND_/APPLICATION_* names (via
// getEnv); consumers do not read process.env directly for those prefixes
// (BRAND-02 invariant). TIMEOFF_* aliases are an eternal compat-shim (D-15):
// they are deprecated (warned once at boot) but never removed, rejected, or
// expired — a self-host operator may rely on TIMEOFF_* indefinitely.

const GENERATIONS = [
  { prefix: 'TIMEOFF_', generation: 1 },
  { prefix: 'LEAVEPILOT_', generation: 2 },
];

const CANONICAL_PREFIX = 'LEAVEPILOT_';

let warned = false;

// Given the surname (the part AFTER the prefix, e.g. 'LICENSE_SECRET'), walk the
// generations newest-generation-first so the canonical (LEAVEPILOT_) value wins
// when both are set; fall back to the deprecated (TIMEOFF_) alias so existing
// deployments keep working (D-15). Returns undefined when neither generation is
// set. Empty/blank values are treated as unset, matching lib/branding.js
// firstValue semantics. Pure: does NOT parse values and does NOT warn here —
// warning is the boot scan's job (reportDeprecations).
const resolve = surname => {
  for (let index = GENERATIONS.length - 1; index >= 0; index -= 1) {
    const value = process.env[GENERATIONS[index].prefix + surname];
    if (typeof value !== 'undefined' && value !== null && value !== '') {
      return value;
    }
  }

  return undefined;
};

// Passthrough returning process.env[name]. Exists ONLY so branding.js stops
// reading process.env.BRAND_* / process.env.APPLICATION_* directly (the BRAND-02
// invariant allowlists this module as the sole read site). BRAND_* is deliberately
// NOT in GENERATIONS (D-05: neutral prefix, separate semantics); no generation
// logic here.
const getEnv = name => process.env[name];

// Pure. Collects old→new pairs for every TIMEOFF_* name present in env, sorted by
// the old name for deterministic output (BRAND-03 ordering edge). Constructs the
// pairs from KEYS ONLY — never reads or embeds env VALUES (prohibition P-02-01,
// ASVS L1 secret-leakage control; threat T-02-01a). Returns a possibly-empty
// array, mirroring the message-or-list shape of lib/security_posture.js.
const describeDeprecations = env => {
  const pairs = [];

  Object.keys(env).forEach(key => {
    if (key.indexOf('TIMEOFF_') === 0) {
      pairs.push({
        old: key,
        new: 'LEAVEPILOT_' + key.slice('TIMEOFF_'.length),
      });
    }
  });

  pairs.sort((a, b) => {
    if (a.old < b.old) {
      return -1;
    }
    if (a.old > b.old) {
      return 1;
    }
    return 0;
  });

  return pairs;
};

// Emits exactly one deprecation warning per process when deprecated TIMEOFF_*
// names are present, carrying the old→new mapping by NAME only. Idempotent: a
// second call in the same process returns the list without re-warning (the
// module-level warned flag). An empty deprecation list short-circuits without
// warning (BRAND-03 empty edge) but still marks the scan done.
const reportDeprecations = (env, logger) => {
  if (warned) {
    return [];
  }

  const pairs = describeDeprecations(env);

  if (pairs.length === 0) {
    warned = true;
    return [];
  }

  const write = (logger || console).warn;
  write.call(
    logger || console,
    'env_resolver: deprecated TIMEOFF_* env names still set — '
      + pairs.map(pair => pair.old + ' → ' + pair.new).join(', ')
      + '. See docs/features-branding.md.'
  );

  warned = true;

  return pairs;
};

// Clears the warned flag so tests are hermetic. Mirrors lib/email_template_paths.reset().
const reset = () => {
  warned = false;
};

module.exports = {
  GENERATIONS,
  CANONICAL_PREFIX,
  resolve,
  getEnv,
  describeDeprecations,
  reportDeprecations,
  reset,
};
