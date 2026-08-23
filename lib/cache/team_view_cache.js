"use strict";

const redis = require('redis');
const log = require('../logger');

const { sessionStore: sessionStoreConfig } = require(__dirname + '/../../config/app.json') || {};

const TEAM_VIEW_CACHE_PREFIX = 'teamview:';
const TEAM_VIEW_CACHE_MAX = 200;
const TEAM_VIEW_VERSION_PREFIX = 'teamview:version:';

let redisClient;
let redisReady = false;
let redisInitAttempted = false;

const memoryCache = new Map();
const memoryVersions = new Map();

const initRedisIfNeeded = () => {
  if (redisInitAttempted) {
    return;
  }
  redisInitAttempted = true;

  if (!sessionStoreConfig || !sessionStoreConfig.useRedis) {
    return;
  }

  const { redisConnectionConfiguration = {} } = sessionStoreConfig;
  const { host, port } = redisConnectionConfiguration;

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
    redisClient = redis.createClient({ socket: { host, port }, RESP: 2 });

    redisClient.on('ready', function () {
      redisReady = true;
      log.info('Redis cache connected successfully');
    });

    redisClient.on('error', function (err) {
      redisReady = false;
      log.warn(`Redis cache error: ${err}`);
    });

    // The cache is best-effort: if the connection never comes up we simply
    // fall back to the in-memory cache below.
    redisClient.connect().catch(error => {
      redisReady = false;
      log.warn(`Failed to connect to Redis cache: ${error}`);
    });
  } catch (error) {
    redisReady = false;
    log.warn(`Failed to initialize Redis cache: ${error}`);
  }
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
  initRedisIfNeeded();
  if (redisReady && redisClient) {
    try {
      return await redisClient.get(key);
    } catch (error) {
      log.warn(`Redis cache get failed: ${error}`);
      return getFromMemory(key);
    }
  }
  return getFromMemory(key);
};

const setHtml = async (key, html, ttlSeconds) => {
  initRedisIfNeeded();
  if (redisReady && redisClient) {
    try {
      await redisClient.setEx(key, ttlSeconds, html);
      return;
    } catch (error) {
      log.warn(`Redis cache set failed: ${error}`);
      setToMemory(key, html, ttlSeconds);
      return;
    }
  }
  setToMemory(key, html, ttlSeconds);
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
    return '1';
  }

  initRedisIfNeeded();
  const versionKey = buildVersionKey(companyId);

  if (redisReady && redisClient) {
    try {
      const value = await redisClient.get(versionKey);
      if (value) {
        return value;
      }
      await redisClient.set(versionKey, '1');
      return '1';
    } catch (error) {
      log.warn(`Redis cache get version failed: ${error}`);
    }
  }

  const current = memoryVersions.get(versionKey);
  if (current) {
    return current;
  }
  memoryVersions.set(versionKey, '1');
  return '1';
};

const bumpCompanyVersion = async (companyId) => {
  if (!companyId) {
    return;
  }

  initRedisIfNeeded();
  const versionKey = buildVersionKey(companyId);

  if (redisReady && redisClient) {
    try {
      await redisClient.incr(versionKey);
      return;
    } catch (error) {
      log.warn(`Redis cache bump version failed: ${error}`);
    }
  }

  const current = Number(memoryVersions.get(versionKey) || '1');
  memoryVersions.set(versionKey, String(current + 1));
};

module.exports = {
  buildKey,
  getHtml,
  setHtml,
  getJson,
  setJson,
  getCompanyVersion,
  bumpCompanyVersion,
};
