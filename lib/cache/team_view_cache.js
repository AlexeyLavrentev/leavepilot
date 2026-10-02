"use strict";

const redis = require('redis');
const log = require('../logger');
const config = require('../config');
const envResolver = require('../env_resolver');

const TEAM_VIEW_CACHE_PREFIX = 'teamview:';
const TEAM_VIEW_CACHE_MAX = 200;
const TEAM_VIEW_VERSION_PREFIX = 'teamview:version:';

// Cache policy modes (D-01..D-06). Exactly one is active at any time and every
// public operation routes through resolveMode():
//   shared                    - shared store configured (sessionStore.useRedis) and client ready
//   bypass-store-unavailable  - shared store configured but not ready / a command failed
//   bypass-no-coordination    - clustered declaration without a shared store: recompute, never cache
//   memory                    - single-process default contour, unchanged behavior (D-03)
const MODE_SHARED = 'shared';
const MODE_BYPASS_STORE_UNAVAILABLE = 'bypass-store-unavailable';
const MODE_BYPASS_NO_COORDINATION = 'bypass-no-coordination';
const MODE_MEMORY = 'memory';

// A failed bump gets exactly three total attempts (initial plus two retries
// with bounded backoff) and then a red log — never a fourth attempt (D-09).
const BUMP_TOTAL_ATTEMPTS = 3;
const BUMP_RETRY_DELAYS_MS = [50, 100];

let redisClient;
let redisReady = false;
let redisInitAttempted = false;
let closed = false;
let closePromise;
let forceClosed = false;

// One warn per degradation episode (reset when the store becomes ready again)
// and one boot-time warn for the missing-coordination policy (D-01/D-05).
let bypassWarned = false;
let noCoordinationWarned = false;

// _reset() fault-injection overrides (tests only).
let injectedClient;
let injectedSessionStore;
let injectedClustered;

const memoryCache = new Map();
const memoryVersions = new Map();

const readSessionStoreConfig = () => (injectedSessionStore !== undefined
  ? injectedSessionStore
  : config.get('sessionStore'));

// The clustered declaration is explicit operator configuration (D-02): stamped
// by bin/wwww_cluster as LEAVEPILOT_CLUSTERED (eternal TIMEOFF_CLUSTERED
// alias) and resolved through lib/env_resolver — never topology sniffing.
const isClustered = () => (injectedClustered !== undefined
  ? injectedClustered === '1'
  : envResolver.resolve('CLUSTERED') === '1');

const currentClient = () => injectedClient || redisClient;

const reportBypass = (mode, error) => {
  if (bypassWarned) { return; }
  bypassWarned = true;
  log.warn('team_view_cache_bypass', {mode, code: error && (error.code || error.name)});
};

const markCommandFailed = (error) => {
  redisReady = false;
  reportBypass(MODE_BYPASS_STORE_UNAVAILABLE, error);
};

const initRedisIfNeeded = () => {
  if (injectedClient || redisInitAttempted || closed) {
    return;
  }
  redisInitAttempted = true;

  const sessionStoreConfig = readSessionStoreConfig();
  if (!sessionStoreConfig || !sessionStoreConfig.useRedis) {
    return;
  }

  const {redisConnectionConfiguration = {}} = sessionStoreConfig;
  const {host, port} = redisConnectionConfiguration;

  if (!(host && port)) {
    log.warn('Redis cache disabled: missing host/port in config.');
    return;
  }

  try {
    // redis v4+ nests the connection details under `socket` and exposes a
    // native promise API, so the legacy promisify wrappers are gone.
    // RESP: 2 pins the wire protocol (see withSession.js): @redis/client
    // 6.x defaults to RESP3/HELLO 3, which the RESP2-compatible compose
    // redis service (Engram) rejects with NOPROTO.
    //
    // The socket options mirror the session client in withSession.js so a
    // lost store fails fast into the bypass policy instead of hanging reads
    // on the offline queue: connectTimeout 1000, reconnectStrategy bounded
    // (retries forever with growing delay so 'ready' re-fires on recovery,
    // D-05), and disableOfflineQueue.
    redisClient = redis.createClient({
      socket: {
        host,
        port,
        connectTimeout: 1000,
        reconnectStrategy: retries => Math.min(1000, 100 * (retries + 1)),
      },
      RESP: 2,
      disableOfflineQueue: true,
    });

    // Degrade/resume is driven purely by the client's own events. The cache
    // is an accelerator, never durable state: no destroy, no exit track.
    redisClient.on('ready', function () {
      redisReady = true;
      bypassWarned = false;
      log.info('team_view_cache_mode', {mode: MODE_SHARED});
    });

    redisClient.on('error', function (err) {
      redisReady = false;
      reportBypass(MODE_BYPASS_STORE_UNAVAILABLE, err);
    });

    redisClient.connect().catch(error => {
      redisReady = false;
      reportBypass(MODE_BYPASS_STORE_UNAVAILABLE, error);
    });
  } catch (error) {
    redisReady = false;
    reportBypass(MODE_BYPASS_STORE_UNAVAILABLE, error);
  }
};

// Pure mode selection over (sessionStore.useRedis, clustered declaration,
// client readiness). Callers re-resolve on every operation: readiness is event
// driven and configuration is read through nconf lazily, so a worker preload
// can config.set('sessionStore', ...) before the first cache operation.
const resolveMode = () => {
  const sessionStoreConfig = readSessionStoreConfig() || {};

  if (sessionStoreConfig.useRedis) {
    const {redisConnectionConfiguration = {}} = sessionStoreConfig;
    const {host, port} = redisConnectionConfiguration;
    if (!(host && port)) {
      // Safe not-configured outcome: warn once (latched) without creating a
      // client, then resolve per the clustered rule — never crash, and never
      // present worker memory as coherent shared state under a clustered
      // declaration.
      initRedisIfNeeded();
      return noCoordinationOrMemory();
    }
    initRedisIfNeeded();
    if (currentClient() && redisReady) {
      return MODE_SHARED;
    }
    return MODE_BYPASS_STORE_UNAVAILABLE;
  }

  return noCoordinationOrMemory();
};

const noCoordinationOrMemory = () => {
  if (!isClustered()) {
    return MODE_MEMORY;
  }
  if (!noCoordinationWarned) {
    noCoordinationWarned = true;
    log.warn('team_view_cache_bypass', {mode: MODE_BYPASS_NO_COORDINATION});
  }
  return MODE_BYPASS_NO_COORDINATION;
};

const purgeMemoryCache = () => {
  const now = Date.now();
  for (const [key, entry] of memoryCache.entries()) {
    if (entry.expiresAt <= now) {
      memoryCache.delete(key);
    }
  }
};

const getFromMemory = (key) => {
  purgeMemoryCache();
  const entry = memoryCache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
};

const setToMemory = (key, value, ttlSeconds) => {
  purgeMemoryCache();
  if (memoryCache.size >= TEAM_VIEW_CACHE_MAX) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) {
      memoryCache.delete(oldestKey);
    }
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
};

const buildKey = (args) => TEAM_VIEW_CACHE_PREFIX + JSON.stringify(args);
const buildVersionKey = (companyId) => `${TEAM_VIEW_VERSION_PREFIX}${companyId}`;

const getHtml = async (key) => {
  const mode = resolveMode();
  if (mode === MODE_BYPASS_NO_COORDINATION || mode === MODE_BYPASS_STORE_UNAVAILABLE) {
    return null;
  }
  if (mode === MODE_MEMORY) {
    return getFromMemory(key);
  }
  const client = currentClient();
  if (!client) {
    return null;
  }
  try {
    return await client.get(key);
  } catch (error) {
    // D-06: a configured store that fails means bypass (recompute), never a
    // silent fallthrough to the process-local memory cache.
    markCommandFailed(error);
    return null;
  }
};

const setHtml = async (key, html, ttlSeconds) => {
  const mode = resolveMode();
  if (mode === MODE_BYPASS_NO_COORDINATION || mode === MODE_BYPASS_STORE_UNAVAILABLE) {
    return;
  }
  if (mode === MODE_MEMORY) {
    setToMemory(key, html, ttlSeconds);
    return;
  }
  const client = currentClient();
  if (!client) {
    return;
  }
  try {
    await client.setEx(key, ttlSeconds, html);
  } catch (error) {
    markCommandFailed(error);
  }
};

const getJson = async (key) => {
  const cached = await getHtml(key);
  if (!cached) {
    return null;
  }

  try {
    return JSON.parse(cached);
  } catch (error) {
    log.warn(`Redis cache JSON parse failed: ${error}`);
    return null;
  }
};

const setJson = async (key, value, ttlSeconds) => {
  await setHtml(key, JSON.stringify(value), ttlSeconds);
};

const getCompanyVersion = async (companyId) => {
  if (!companyId) {
    return null;
  }

  const mode = resolveMode();
  if (mode === MODE_BYPASS_NO_COORDINATION || mode === MODE_BYPASS_STORE_UNAVAILABLE) {
    return null;
  }

  const versionKey = buildVersionKey(companyId);

  if (mode === MODE_MEMORY) {
    const current = memoryVersions.get(versionKey);
    if (current) {
      return current;
    }
    memoryVersions.set(versionKey, '1');
    return '1';
  }

  const client = currentClient();
  if (!client) {
    return null;
  }

  try {
    const value = await client.get(versionKey);
    if (value) {
      return value;
    }
    // Atomic initialization: a single SET-with-NX command. The previous
    // GET-then-SET window could clobber a concurrent INCR from another
    // worker back to '1' (version regression -> stale entries reachable
    // again), and a read-side INCR would self-invalidate every entry.
    await client.set(versionKey, '1', { NX: true });
    const initialized = await client.get(versionKey);
    return initialized || '1';
  } catch (error) {
    // D-06: bypass signal — the caller recomputes without caching.
    markCommandFailed(error);
    return null;
  }
};

const bumpCompanyVersion = async (companyId) => {
  if (!companyId) {
    return;
  }

  const mode = resolveMode();

  if (mode === MODE_BYPASS_NO_COORDINATION) {
    // Nothing is ever cached without shared coordination, so there is
    // nothing to invalidate.
    return;
  }

  const versionKey = buildVersionKey(companyId);

  if (mode === MODE_MEMORY) {
    const current = Number(memoryVersions.get(versionKey) || '1');
    memoryVersions.set(versionKey, String(current + 1));
    return;
  }

  // shared and bypass-store-unavailable both attempt the bump: the store may
  // have returned, and advancing the shared version then is what makes the
  // recovery coherent (best effort with bounded retry, D-09).
  const client = currentClient();
  if (!client) {
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= BUMP_TOTAL_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await new Promise(resolve => setTimeout(resolve, BUMP_RETRY_DELAYS_MS[attempt - 2]));
    }
    try {
      await client.incr(versionKey);
      return;
    } catch (error) {
      lastError = error;
      markCommandFailed(error);
    }
  }
  log.error('team_view_invalidation_failed', {
    companyId,
    code: lastError && (lastError.code || lastError.name),
  });
};

const getStatus = () => {
  const mode = resolveMode();
  const store = mode === MODE_SHARED || mode === MODE_BYPASS_STORE_UNAVAILABLE
    ? 'redis'
    : mode === MODE_MEMORY ? 'memory' : 'none';
  return Object.freeze({ mode, store });
};

const close = () => {
  if (closePromise) { return closePromise; }
  closed = true;
  redisReady = false;
  const client = currentClient();
  closePromise = client ? Promise.resolve().then(() => client.close()) : Promise.resolve();
  return closePromise;
};

const forceClose = () => {
  if (forceClosed) { return; }
  forceClosed = true;
  closed = true;
  redisReady = false;
  const client = currentClient();
  if (client) { client.destroy(); }
};

// Test-only hook (underscore convention, see lib/middleware/request_logger.js):
// clears every piece of module state and optionally injects a fake client plus
// a config snapshot (sessionStore / clustered declaration) for fault injection.
// When a client is injected, the module's ready/error listeners are attached to
// it so degrade/resume can be driven by emitting those events. Returns the live
// memory maps so tests can prove no memory fallback ever runs under a
// configured Redis (D-06).
const _reset = (options = {}) => {
  redisClient = null;
  injectedClient = options.client || null;
  injectedSessionStore = options.sessionStore;
  injectedClustered = options.clustered;
  redisReady = options.ready === true;
  redisInitAttempted = false;
  closed = false;
  closePromise = undefined;
  forceClosed = false;
  bypassWarned = false;
  noCoordinationWarned = false;
  memoryCache.clear();
  memoryVersions.clear();

  if (injectedClient && typeof injectedClient.on === 'function') {
    injectedClient.on('ready', function () {
      redisReady = true;
      bypassWarned = false;
      log.info('team_view_cache_mode', {mode: MODE_SHARED});
    });
    injectedClient.on('error', function (err) {
      redisReady = false;
      reportBypass(MODE_BYPASS_STORE_UNAVAILABLE, err);
    });
  }

  return { memoryCache, memoryVersions };
};

module.exports = {
  buildKey,
  getHtml,
  setHtml,
  getJson,
  setJson,
  getCompanyVersion,
  bumpCompanyVersion,
  close,
  forceClose,
  getStatus,
  _reset,
};
