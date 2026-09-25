
const session = require('express-session');
const {AsyncLocalStorage} = require('node:async_hooks');
const SequelizeStore = require('connect-session-sequelize')(session.Store);
const log = require('../logger');

const redis = require('redis');
const connectRedis = require('connect-redis');
const config = require('../config');
const {createSessionLifecycle} = require('./session_lifecycle');

// connect-redis v9 ships its store as a named `RedisStore` export. Under Node's
// `require(ESM)` interop the namespace may arrive wrapped in `.default`, so
// resolve defensively rather than assuming one shape.
const RedisStore = connectRedis.RedisStore
  || (connectRedis.default && connectRedis.default.RedisStore)
  || connectRedis.default
  || connectRedis;

const sessionStoreConfig = config.get('sessionStore') || {};

const parseBoolean = (value, defaultValue) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) {
      return true;
    }

    if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) {
      return false;
    }
  }

  return defaultValue;
};

const parseCookieSameSite = (value) => {
  const normalizedValue = typeof value === 'string' ? value.toLowerCase() : 'lax';
  const allowedValues = ['lax', 'strict', 'none'];

  if (!allowedValues.includes(normalizedValue)) {
    throw new Error('Unsupported SESSION_COOKIE_SAME_SITE value: ' + value);
  }

  return normalizedValue;
};

const parseMaxAge = (value, defaultValue) => {
  if (typeof value === 'undefined' || value === null || value === '') {
    return defaultValue;
  }

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error('SESSION_COOKIE_MAX_AGE_MS must be a positive integer');
  }

  return parsedValue;
};

const createSessionMiddleware = ({
  sequelizeDb,
}) => {
  let store;
  let rateLimitRedisClient = null;
  let initializePromise;
  let closePromise;
  let state = 'created';
  const listeners = new Set();
  const notify = (nextState, error) => {
    if (state === 'closed' || state === 'failed') { return; }
    state = nextState;
    for (const listener of listeners) {
      listener({state: nextState, error});
    }
  };
  let initializeStore;
  let redisLifecycle;
  const redisResponse = new AsyncLocalStorage();

  if (sessionStoreConfig && sessionStoreConfig.useRedis) {
    const {redisConnectionConfiguration = {}} = sessionStoreConfig;
    const {host, port} = redisConnectionConfiguration;
    if (!(host && port)) {
      throw new Error('Missing configuration for Redis to use with Sessions');
    }
    // redis v4+ takes the connection details under `socket` and starts
    // disconnected, so we explicitly connect the client below. RESP: 2
    // pins the wire protocol: @redis/client 6.x defaults to RESP3 and
    // opens with HELLO 3, which the compose redis service (Engram, a
    // RESP2-compatible engine) answers with NOPROTO - every session
    // command would fail (caught by the 06-01 install check on its
    // first full docker-compose run).
    const redisClient = redis.createClient({
      socket: {
        host, port, connectTimeout: 1000,
        reconnectStrategy: retries => Math.min(1000, 100 * (retries + 1)),
      },
      RESP: 2, disableOfflineQueue: true,
    });
    rateLimitRedisClient = redisClient;
    store = new RedisStore({ client: redisClient });
    redisLifecycle = createSessionLifecycle({
      store, client: redisClient, logger: log,
      onOperationFailure: () => {
        const response = redisResponse.getStore();
        if (response && !response.writableEnded) { response.destroy(); }
      },
      recoveryTimeoutMs: process.env.NODE_ENV === 'test' && process.env.TEST_SESSION_RECOVERY_MS
        ? Number(process.env.TEST_SESSION_RECOVERY_MS) : undefined,
      operationTimeoutMs: process.env.NODE_ENV === 'test' && process.env.TEST_SESSION_OPERATION_MS
        ? Number(process.env.TEST_SESSION_OPERATION_MS) : undefined,
    });
  } else {
    if (!sequelizeDb) {
      throw new Error('Database connection was not provided into Session store manager!');
    }
    store = new SequelizeStore({ db: sequelizeDb });
    initializeStore = () => store.sync();
  }

  const cookieSecure = parseBoolean(config.get('session_cookie_secure'), false);
  const cookieSameSite = parseCookieSameSite(config.get('session_cookie_same_site'));
  const cookieMaxAge = parseMaxAge(
    config.get('session_cookie_max_age_ms'),
    12 * 60 * 60 * 1000
  );

  if (cookieSameSite === 'none' && !cookieSecure) {
    throw new Error('SESSION_COOKIE_SAME_SITE=none requires SESSION_COOKIE_SECURE=true');
  }

  const baseMiddleware = session({
    store,
    secret: config.get('session_secret'),
    resave: false,
    saveUninitialized: false,
    proxy: parseBoolean(config.get('trust_proxy'), false),
    cookie: {
      httpOnly: true,
      sameSite: cookieSameSite,
      secure: cookieSecure,
      maxAge: cookieMaxAge,
    },
  });
  const middleware = redisLifecycle
    ? (req, res, next) => redisResponse.run(res, () => baseMiddleware(req, res, next))
    : baseMiddleware;

  // Rate limiting reuses session Redis connection. No second client, socket,
  // or shutdown lifecycle needed.
  middleware.rateLimitRedisClient = rateLimitRedisClient;

  // Expose a narrow lifecycle hook for tests and graceful application
  // shutdown. connect-session-sequelize otherwise keeps its expiry timer
  // alive after the database has been closed.
  const sessionLifecycle = {
    initialize() {
      if (state === 'closed') {
        return Promise.reject(new Error('Session store is closed'));
      }
      if (!initializePromise) {
        initializePromise = Promise.resolve().then(initializeStore).then(() => {
          if (state !== 'closed' && state !== 'failed') { notify('ready'); }
        }, error => {
          // The runtime classifies startup errors and may retry a transient
          // connection failure. Post-ready failures still notify its owner.
          initializePromise = null;
          throw error;
        });
      }
      return initializePromise;
    },
    isReady: () => state === 'ready',
    reportFailure: error => notify('failed', error),
    onStateChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      if (!closePromise) {
        closePromise = Promise.resolve().then(async () => {
          state = 'closed';
          listeners.clear();
          if (store && typeof store.stopExpiringSessions === 'function') {
            store.stopExpiringSessions();
          }
          if (rateLimitRedisClient && rateLimitRedisClient.isOpen) {
            await rateLimitRedisClient.quit();
          }
        });
      }
      return closePromise;
    },
    forceClose() { return this.close(); },
  };
  middleware.sessionLifecycle = redisLifecycle || sessionLifecycle;
  middleware.close = () => middleware.sessionLifecycle.close();

  return middleware;
};

module.exports = createSessionMiddleware;
