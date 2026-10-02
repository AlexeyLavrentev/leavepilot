'use strict';

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const config = require('../../../lib/config');
const log = require('../../../lib/logger');
const teamViewCache = require('../../../lib/cache/team_view_cache');

// Fake RESP2 client in the session_lifecycle.js fixture style: an EventEmitter
// with controllable command handlers so both outcomes and failures are
// deterministic. Errors deliberately carry a "private transport detail"
// message so log-discipline assertions can prove it never reaches a log line.
function fakeClient(options = {}) {
  const client = new EventEmitter();
  client.isOpen = true;
  client.destroyed = false;
  client.connect = async () => {};
  client.close = async () => { client.isOpen = false; };
  client.destroy = () => { client.isOpen = false; client.destroyed = true; };
  client.calls = [];
  client.values = new Map(options.values || []);
  client.handlers = options.handlers || {};
  client.get = async key => {
    client.calls.push(['get', key]);
    if (client.handlers.get) { return client.handlers.get(key); }
    return client.values.get(key) ?? null;
  };
  client.set = async (key, value, options2) => {
    client.calls.push(['set', key, value, options2]);
    if (client.handlers.set) { return client.handlers.set(key, value, options2); }
    if (!options2 || !options2.NX || !client.values.has(key)) { client.values.set(key, value); }
    return 'OK';
  };
  client.setEx = async (key, ttl, value) => {
    client.calls.push(['setEx', key, ttl, value]);
    if (client.handlers.setEx) { return client.handlers.setEx(key, ttl, value); }
    client.values.set(key, value);
    return 'OK';
  };
  client.incr = async key => {
    client.calls.push(['incr', key]);
    if (client.handlers.incr) { return client.handlers.incr(key); }
    const next = Number(client.values.get(key) || 0) + 1;
    client.values.set(key, String(next));
    return next;
  };
  return client;
}

async function until(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), 'condition did not become true');
}

const recorded = [];
const originalWarn = log.warn;
const originalInfo = log.info;
const originalError = log.error;
const originalSessionStore = config.get('sessionStore');

const fake = () => Promise.reject(new Error('private transport detail'));

describe('team view cache policy', function() {
  this.timeout(10000);

  beforeEach(function() {
    recorded.length = 0;
    log.warn = (...args) => recorded.push(['warn', ...args]);
    log.info = (...args) => recorded.push(['info', ...args]);
    log.error = (...args) => recorded.push(['error', ...args]);
  });

  afterEach(async function() {
    log.warn = originalWarn;
    log.info = originalInfo;
    log.error = originalError;
    config.set('sessionStore', originalSessionStore);
    // Defensive: a test that accidentally created a real client must not
    // leave a reconnecting socket keeping the mocha process alive.
    await teamViewCache.close();
    teamViewCache._reset();
  });

  const configureRedis = (overrides = {}) => config.set('sessionStore', {
    useRedis: true,
    redisConnectionConfiguration: {host: 'cache-unit-host', port: 16379, ...overrides},
  });

  it('selects shared mode when the store is configured and the client is ready', function() {
    configureRedis();
    const client = fakeClient();
    const memory = teamViewCache._reset({client, ready: true});
    assert.deepEqual(teamViewCache.getStatus(), {mode: 'shared', store: 'redis'});
    assert.equal(memory.memoryCache.size, 0);
  });

  it('selects bypass-store-unavailable when the configured client is not ready', function() {
    configureRedis();
    const client = fakeClient();
    teamViewCache._reset({client});
    assert.deepEqual(teamViewCache.getStatus(), {mode: 'bypass-store-unavailable', store: 'redis'});
  });

  it('selects bypass-no-coordination for a clustered declaration without a store', function() {
    config.set('sessionStore', {useRedis: false});
    const memory = teamViewCache._reset({clustered: '1'});
    assert.deepEqual(teamViewCache.getStatus(), {mode: 'bypass-no-coordination', store: 'none'});
    // Every operation bypasses: recompute, never read, never write, never bump.
    return Promise.all([
      teamViewCache.getCompanyVersion(1),
      teamViewCache.getHtml('teamview:{}}'),
      teamViewCache.setHtml('teamview:{}}', 'html', 30),
      teamViewCache.bumpCompanyVersion(1),
    ]).then(([version, html]) => {
      assert.equal(version, null);
      assert.equal(html, null);
      assert.equal(memory.memoryCache.size, 0);
      assert.equal(memory.memoryVersions.size, 0);
      const warns = recorded.filter(([level]) => level === 'warn')
        .filter(([, event]) => event === 'team_view_cache_bypass');
      assert.equal(warns.length, 1, 'exactly one boot-time bypass warn');
    });
  });

  it('resolves the clustered declaration through the env resolver namespace', async function() {
    config.set('sessionStore', {useRedis: false});
    process.env.LEAVEPILOT_CLUSTERED = '1';
    try {
      teamViewCache._reset();
      assert.equal(teamViewCache.getStatus().mode, 'bypass-no-coordination');
    } finally {
      delete process.env.LEAVEPILOT_CLUSTERED;
    }
  });

  it('accepts the boolean spellings true/1/yes/on for the clustered declaration, case-insensitive', async function() {
    config.set('sessionStore', {useRedis: false});
    for (const literal of ['true', '1', 'yes', 'on', 'TRUE', 'Yes']) {
      process.env.LEAVEPILOT_CLUSTERED = literal;
      try {
        teamViewCache._reset();
        assert.equal(teamViewCache.getStatus().mode, 'bypass-no-coordination', literal);
      } finally {
        delete process.env.LEAVEPILOT_CLUSTERED;
      }
    }
    // The _reset injection seam parses through the same literals.
    teamViewCache._reset({clustered: 'true'});
    assert.equal(teamViewCache.getStatus().mode, 'bypass-no-coordination');
  });

  it('resolves an unrecognized clustered declaration falsy with exactly one explicit warn, never silently', async function() {
    config.set('sessionStore', {useRedis: false});
    process.env.LEAVEPILOT_CLUSTERED = 'enabled';
    try {
      teamViewCache._reset();
      assert.equal(teamViewCache.getStatus().mode, 'memory');
      teamViewCache.getStatus(); // a second resolution stays warn-once
      const warns = recorded.filter(([level]) => level === 'warn')
        .filter(([, event]) => event === 'team_view_cache_clustered_unrecognized');
      assert.equal(warns.length, 1, 'exactly one unrecognized-value warn');
      assert.equal(warns[0][2].variable, 'LEAVEPILOT_CLUSTERED');
      assert.equal(warns[0][2].accepted, 'true|1|yes|on');
    } finally {
      delete process.env.LEAVEPILOT_CLUSTERED;
    }

    // An empty value is "unset" by env_resolver semantics: plain memory mode,
    // and the unrecognized-value warn never fires for it. Only entries recorded
    // from this point on may carry the warn (the earlier part of this test
    // legitimately produced exactly one).
    const recordedBefore = recorded.length;
    process.env.LEAVEPILOT_CLUSTERED = '';
    try {
      teamViewCache._reset();
      assert.equal(teamViewCache.getStatus().mode, 'memory');
      assert.ok(!recorded.slice(recordedBefore).some(([level, event]) => level === 'warn' && event === 'team_view_cache_clustered_unrecognized'),
        'no warn for an empty declaration');
    } finally {
      delete process.env.LEAVEPILOT_CLUSTERED;
    }
  });

  it('keeps the single-process memory mode when neither store nor clustering is declared', function() {
    config.set('sessionStore', {useRedis: false});
    teamViewCache._reset();
    assert.deepEqual(teamViewCache.getStatus(), {mode: 'memory', store: 'memory'});
  });

  it('resolves a configured store without host/port safely and never memory-caches under clustering', async function() {
    // Driven through the _reset config snapshot: nconf merges repeated
    // sessionStore writes with earlier values, so the unit seam must not
    // depend on nconf mutation for this contour.
    const clustered = teamViewCache._reset({
      clustered: '1',
      sessionStore: {useRedis: true, redisConnectionConfiguration: {}},
    });
    assert.equal(teamViewCache.getStatus().mode, 'bypass-no-coordination');
    assert.equal(await teamViewCache.getCompanyVersion(1), null);
    assert.equal(clustered.memoryCache.size, 0);
    assert.equal(clustered.memoryVersions.size, 0);

    teamViewCache._reset({sessionStore: {useRedis: true, redisConnectionConfiguration: {}}});
    assert.equal(teamViewCache.getStatus().mode, 'memory');
    assert.ok(recorded.some(([level, message]) => level === 'warn' && /missing host\/port/.test(String(message))),
      'the not-configured warn is retained');
  });

  it('initializes the company version with a single SET NX and never clobbers a concurrent incr', async function() {
    configureRedis();
    const client = fakeClient();
    // Simulate another worker INCRing between our read miss and the init.
    client.handlers.get = key => (client.values.has(key) ? client.values.get(key) : null);
    client.handlers.set = (key, value, options2) => {
      if (options2 && options2.NX) {
        // A concurrent INCR lands first; the NX init must not overwrite it.
        client.values.set(key, '2');
        return null;
      }
      throw new Error('bare SET after a GET miss is forbidden');
    };
    teamViewCache._reset({client, ready: true});

    const version = await teamViewCache.getCompanyVersion(7);
    assert.equal(version, '2');

    const versionKey = 'teamview:version:7';
    const setCalls = client.calls.filter(([command, key]) => command === 'set' && key === versionKey);
    assert.equal(setCalls.length, 1, 'exactly one initialization command');
    assert.deepEqual(setCalls[0][3], {NX: true}, 'initialization uses NX semantics');
    assert.ok(!client.calls.some(([command, , value, options2]) => command === 'set' && !options2),
      'no bare SET was issued');
  });

  it('does not advance the version on a read hit', async function() {
    configureRedis();
    const client = fakeClient({values: [['teamview:version:5', '41']]});
    teamViewCache._reset({client, ready: true});
    assert.equal(await teamViewCache.getCompanyVersion(5), '41');
    assert.ok(client.calls.every(([command]) => command === 'get'), 'only GET was issued');
  });

  it('never reaches process memory under a configured store when commands fail (D-06)', async function() {
    configureRedis();
    const client = fakeClient({handlers: {get: fake, set: fake, setEx: fake, incr: fake}});
    const memory = teamViewCache._reset({client, ready: true});

    assert.equal(await teamViewCache.getHtml('teamview:x'), null);
    await teamViewCache.setHtml('teamview:x', 'html', 30);
    assert.equal(await teamViewCache.getCompanyVersion(9), null);
    await teamViewCache.bumpCompanyVersion(9);

    assert.equal(memory.memoryCache.size, 0, 'memoryCache stays empty');
    assert.equal(memory.memoryVersions.size, 0, 'memoryVersions stays empty');
  });

  it('degrades to bypass on an error event and resumes on ready without closing or exiting (D-05)', async function() {
    configureRedis();
    const client = fakeClient();
    teamViewCache._reset({client, ready: true});
    assert.equal(teamViewCache.getStatus().mode, 'shared');

    const transportError = Object.assign(new Error('private transport detail'), {code: 'ECONNREFUSED'});
    client.emit('error', transportError);
    assert.equal(teamViewCache.getStatus().mode, 'bypass-store-unavailable');
    client.emit('error', transportError);
    client.emit('error', transportError);

    const warns = recorded.filter(([level]) => level === 'warn')
      .filter(([, event]) => event === 'team_view_cache_bypass');
    assert.equal(warns.length, 1, 'repeated error events stay rate limited');

    client.emit('ready');
    assert.equal(teamViewCache.getStatus().mode, 'shared');
    const modes = recorded.filter(([level]) => level === 'info')
      .filter(([, event]) => event === 'team_view_cache_mode');
    assert.ok(modes.length >= 1, 'ready emits team_view_cache_mode');

    assert.equal(client.destroyed, false, 'the client is never destroyed');
    assert.equal(client.isOpen, true, 'the client is never closed');
  });

  it('preserves single-process memory semantics: insertion-order eviction and TTL expiry (D-03)', async function() {
    config.set('sessionStore', {useRedis: false});
    const memory = teamViewCache._reset();
    for (let index = 0; index < 201; index++) {
      await teamViewCache.setHtml(`teamview:key-${index}`, `html-${index}`, 60);
    }
    assert.equal(await teamViewCache.getHtml('teamview:key-0'), null, 'oldest entry evicted at the 200 bound');
    assert.equal(await teamViewCache.getHtml('teamview:key-200'), 'html-200');
    assert.equal(memory.memoryCache.size, 200);

    await teamViewCache.setHtml('teamview:expired', 'gone', 0);
    assert.equal(await teamViewCache.getHtml('teamview:expired'), null, 'zero TTL expires immediately');
  });

  it('retries a failed bump exactly three times and logs one red event (D-09)', async function() {
    configureRedis();
    const client = fakeClient({handlers: {incr: () => Promise.reject(new Error('private transport detail'))}});
    teamViewCache._reset({client, ready: true});

    await teamViewCache.bumpCompanyVersion(3);

    const incrCalls = client.calls.filter(([command]) => command === 'incr');
    assert.equal(incrCalls.length, 3, 'exactly three attempts, never a fourth');
    const errors = recorded.filter(([level]) => level === 'error')
      .filter(([, event]) => event === 'team_view_invalidation_failed');
    assert.equal(errors.length, 1, 'exactly one red log');
  });

  it('stops retrying when the bump succeeds on the second attempt', async function() {
    configureRedis();
    let attempts = 0;
    const client = fakeClient({handlers: {incr: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('transient')) : Promise.resolve(2);
    }}});
    teamViewCache._reset({client, ready: true});

    await teamViewCache.bumpCompanyVersion(4);
    assert.equal(attempts, 2);
    assert.equal(recorded.filter(([level]) => level === 'error').length, 0);
  });

  it('serializes concurrent bumps into consecutive per-company integers without cross-talk', async function() {
    configureRedis();
    const client = fakeClient();
    teamViewCache._reset({client, ready: true});

    await teamViewCache.getCompanyVersion(11);
    const before = Number(client.values.get('teamview:version:11'));
    await Promise.all([
      teamViewCache.bumpCompanyVersion(11),
      teamViewCache.bumpCompanyVersion(11),
    ]);
    assert.equal(client.values.get('teamview:version:11'), String(before + 2), 'no lost update');

    await teamViewCache.bumpCompanyVersion(12);
    assert.equal(client.values.get('teamview:version:11'), String(before + 2), 'one company bump never touches another');
    assert.equal(client.values.get('teamview:version:12'), '1');
    assert.ok(!client.values.has('teamview:version:13'), 'a never-read, never-mutated company has no key at all');
  });

  it('returns a bypass signal for falsy company ids and writes no version key', async function() {
    configureRedis();
    const client = fakeClient();
    teamViewCache._reset({client, ready: true});

    assert.equal(await teamViewCache.getCompanyVersion(null), null);
    assert.equal(await teamViewCache.getCompanyVersion(0), null);
    assert.equal(await teamViewCache.getCompanyVersion(''), null);
    await teamViewCache.bumpCompanyVersion(null);
    await teamViewCache.bumpCompanyVersion('');
    assert.equal(client.calls.length, 0, 'no command was issued for a missing id');
  });

  it('keeps version values as decimal integer strings end to end (never numbers or floats)', async function() {
    configureRedis();
    const client = fakeClient();
    teamViewCache._reset({client, ready: true});

    const initialized = await teamViewCache.getCompanyVersion(21);
    assert.equal(typeof initialized, 'string');
    assert.match(initialized, /^\d+$/);
    await teamViewCache.bumpCompanyVersion(21);
    const afterBump = client.values.get('teamview:version:21');
    assert.equal(typeof afterBump, 'string');
    assert.match(afterBump, /^\d+$/);

    config.set('sessionStore', {useRedis: false});
    const memory = teamViewCache._reset();
    const memoryVersion = await teamViewCache.getCompanyVersion(22);
    assert.equal(typeof memoryVersion, 'string');
    assert.match(memoryVersion, /^\d+$/);
    await teamViewCache.bumpCompanyVersion(22);
    assert.match(memory.memoryVersions.get('teamview:version:22'), /^\d+$/);
  });

  it('routes getJson and setJson through the html path', async function() {
    config.set('sessionStore', {useRedis: false});
    teamViewCache._reset();
    await teamViewCache.setJson('teamview:json', {days: [1, 2]}, 30);
    assert.deepEqual(await teamViewCache.getJson('teamview:json'), {days: [1, 2]});
    assert.equal(await teamViewCache.getJson('teamview:missing'), null);

    config.set('sessionStore', {useRedis: false});
    teamViewCache._reset({clustered: '1'});
    assert.equal(await teamViewCache.getJson('teamview:json'), null, 'bypass never reads');
    await teamViewCache.setJson('teamview:json', {days: [1]}, 30);
  });

  it('never logs host, port, or raw transport details', async function() {
    configureRedis();
    const client = fakeClient({handlers: {get: fake, incr: fake}});
    teamViewCache._reset({client, ready: true});
    client.emit('error', Object.assign(new Error('private transport detail'), {code: 'ECONNREFUSED'}));
    await teamViewCache.getHtml('teamview:x');
    await teamViewCache.bumpCompanyVersion(1);

    const serialized = JSON.stringify(recorded);
    assert.ok(!serialized.includes('cache-unit-host'), 'no host in logs');
    assert.ok(!serialized.includes('16379'), 'no port in logs');
    assert.ok(!serialized.includes('private transport detail'), 'no raw transport message in logs');
  });

  it('keeps getStatus frozen to mode and store only', function() {
    configureRedis();
    const client = fakeClient();
    teamViewCache._reset({client, ready: true});
    const status = teamViewCache.getStatus();
    assert.ok(Object.isFrozen(status));
    assert.deepEqual(Object.keys(status).sort(), ['mode', 'store']);
  });
});
