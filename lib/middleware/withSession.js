
const session = require('express-session');
const SequelizeStore = require('connect-session-sequelize')(session.Store);
const Sequelize = require('sequelize');

const redis = require('redis');
const connectRedis = require('connect-redis');
const config = require('../config');

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

const asCallback = (promise, callback) => {
  if (typeof callback === 'function') {
    promise.then(
      value => callback(null, value),
      error => callback(error)
    );
  }

  return promise;
};

const patchSequelizeStoreForSequelize6 = store => {
  const sessionModel = store.sessionModel;

  store.get = function getSession(sid, callback) {
    return asCallback(
      sessionModel.findOne({ where: { sid } })
        .then(sessionRecord => sessionRecord ? JSON.parse(sessionRecord.data) : null),
      callback
    );
  };

  store.set = function setSession(sid, data, callback) {
    const stringData = JSON.stringify(data);
    const expires = data.cookie && data.cookie.expires
      ? data.cookie.expires
      : new Date(Date.now() + store.options.expiration);

    return asCallback(
      sessionModel.findOrCreate({
        where: { sid },
        defaults: { data: stringData, expires },
      })
        .then(([sessionRecord]) => {
          if (sessionRecord.data === stringData && String(sessionRecord.expires) === String(expires)) {
            return data;
          }

          sessionRecord.data = stringData;
          sessionRecord.expires = expires;
          return sessionRecord.save().then(() => data);
        }),
      callback
    );
  };

  store.touch = function touchSession(sid, data, callback) {
    const expires = data.cookie && data.cookie.expires
      ? data.cookie.expires
      : new Date(Date.now() + store.options.expiration);

    return asCallback(
      sessionModel.update({ expires }, { where: { sid } }).then(() => null),
      callback
    );
  };

  store.destroy = function destroySession(sid, callback) {
    return asCallback(
      sessionModel.findOne({ where: { sid } })
        .then(sessionRecord => sessionRecord ? sessionRecord.destroy() : null),
      callback
    );
  };

  store.length = function calcLength(callback) {
    return asCallback(sessionModel.count(), callback);
  };

  store.clearExpiredSessions = function clearExpiredSessions(callback) {
    return asCallback(
      sessionModel.destroy({
        where: {
          expires: {
            [Sequelize.Op.lt]: new Date(),
          },
        },
      }),
      callback
    );
  };

  store.stopExpiringSessions();
  store.startExpiringSessions();
};

const createSessionMiddleware = ({
  sequelizeDb,
}) => {
  let store;
  let rateLimitRedisClient = null;

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
    const redisClient = redis.createClient({ socket: { host, port }, RESP: 2 });
    rateLimitRedisClient = redisClient;

    redisClient.on('error', function (err) {
      console.error(`Redis session store error: ${err}`);
    });
    redisClient.on('connect', function () {
      console.log('Connected to redis successfully');
    });

    // The session middleware is mounted synchronously but only handles
    // requests once the server is listening, by which point this connection
    // has settled. A rejected connect() surfaces as a fatal boot error.
    redisClient.connect().catch(err => {
      throw new Error(`Failed to connect to Redis: ${err}`);
    });

    store = new RedisStore({ client: redisClient });
  } else {
    if (!sequelizeDb) {
      throw new Error('Database connection was not provided into Session store manager!');
    }
    if (typeof sequelizeDb.import !== 'function') {
      sequelizeDb.import = modelPath => require(modelPath)(sequelizeDb, Sequelize.DataTypes);
    }
    store = new SequelizeStore({ db: sequelizeDb });
    patchSequelizeStoreForSequelize6(store);
    store.sync();
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

  const middleware = session({
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

  // Rate limiting reuses session Redis connection. No second client, socket,
  // or shutdown lifecycle needed.
  middleware.rateLimitRedisClient = rateLimitRedisClient;

  // Expose a narrow lifecycle hook for tests and graceful application
  // shutdown. connect-session-sequelize otherwise keeps its expiry timer
  // alive after the database has been closed.
  middleware.close = function closeSessionStore() {
    if (store && typeof store.stopExpiringSessions === 'function') {
      store.stopExpiringSessions();
    }
    if (store && store.client && typeof store.client.quit === 'function') {
      // redis v4+ returns a promise from quit(); swallow rejections (e.g. the
      // client was never connected) so shutdown stays best-effort.
      Promise.resolve(store.client.quit()).catch(() => {});
    }
  };

  return middleware;
};

module.exports = createSessionMiddleware;
