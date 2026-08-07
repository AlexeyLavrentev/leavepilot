'use strict';

/*
 * In-process HTTP test agent.
 *
 * Boots the express app against an in-memory SQLite database and exposes a
 * minimal supertest-like agent (cookies + CSRF handling) for API tests that
 * do not need a browser. Adapted from the premium module test bootstrap.
 */

const TEST_ENV = {
  NODE_ENV: 'test',
  DB_DIALECT: 'sqlite',
  DB_STORAGE: ':memory:',
  DB_LOGGING: 'false',
  SILENCE_PRETEND_EMAILS: 'true',
  SILENCE_HTTP_LOGS: 'true',
  DISABLE_AUTH_RATE_LIMIT: 'true',
};

let app;
let readyPromise;
let server;
let savedEnv = null;

// Env is applied lazily (not at module load) and restored in close() so the
// overrides do not leak into unrelated unit tests running in the same
// mocha process.
function applyTestEnv() {
  if (savedEnv) {
    return;
  }
  savedEnv = {};
  Object.keys(TEST_ENV).forEach(key => {
    savedEnv[key] = process.env[key];
    process.env[key] = TEST_ENV[key];
  });
}

function restoreTestEnv() {
  if (!savedEnv) {
    return;
  }
  Object.keys(savedEnv).forEach(key => {
    if (typeof savedEnv[key] === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  });
  savedEnv = null;
}

function getApp() {
  applyTestEnv();
  if (!app) {
    app = require('../../app');
  }
  return app;
}

async function ready() {
  if (!readyPromise) {
    readyPromise = getApp().get('db_model').sequelize.sync({force: true});
  }
  await readyPromise;
  return getApp();
}

class TestRequest {
  constructor(testAgent, method, url) {
    this.testAgent = testAgent;
    this.method = method;
    this.url = url;
    this.payload = undefined;
    this.expectations = [];
  }

  type(value) {
    this.contentType = value;
    return this;
  }

  send(payload) {
    this.payload = payload || {};
    return this;
  }

  query(params) {
    const query = new URLSearchParams(params).toString();
    this.url += (this.url.includes('?') ? '&' : '?') + query;
    return this;
  }

  expect(name, value) {
    this.expectations.push(value === undefined
      ? {status: name}
      : {header: String(name).toLowerCase(), value});
    return this;
  }

  async run() {
    const headers = {};
    const cookieHeader = Array.from(this.testAgent.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    if (cookieHeader) headers.cookie = cookieHeader;
    if (this.testAgent.csrfToken) headers['x-csrf-token'] = this.testAgent.csrfToken;

    let body;
    if (this.payload !== undefined) {
      if (this.contentType === 'form') {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(this.payload).toString();
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(this.payload);
      }
    }

    const response = await fetch(this.testAgent.baseUrl + this.url, {
      method: this.method,
      headers,
      body,
      redirect: 'manual',
    });
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const setCookie of setCookies) {
      const pair = setCookie.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.testAgent.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }

    const text = await response.text();
    const csrfMatch = text.match(/name=["']_csrf["'][^>]*value=["']([^"']+)/i);
    if (csrfMatch) this.testAgent.csrfToken = csrfMatch[1];

    let responseBody = {};
    if ((response.headers.get('content-type') || '').includes('json') && text) {
      responseBody = JSON.parse(text);
    }

    for (const expectation of this.expectations) {
      if (expectation.status !== undefined && response.status !== expectation.status) {
        throw new Error(`Expected HTTP ${expectation.status}, received ${response.status} for ${this.method} ${this.url}; location=${response.headers.get('location') || ''}; cookies=${Array.from(this.testAgent.cookies.keys()).join(',')}`);
      }
      if (expectation.header) {
        const actual = response.headers.get(expectation.header) || '';
        const matches = expectation.value instanceof RegExp
          ? expectation.value.test(actual)
          : actual === expectation.value;
        if (!matches) throw new Error(`Unexpected ${expectation.header}: ${actual}`);
      }
    }

    if (this.method === 'POST' && /^\/login\/?$/.test(this.url)
        && response.status === 302 && response.headers.get('location') === '/') {
      await this.testAgent.get('/calendar/').expect(200);
    }

    return {
      status: response.status,
      text,
      body: responseBody,
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  then(resolve, reject) {
    return this.run().then(resolve, reject);
  }
}

async function agent() {
  await ready();
  if (!server) {
    server = await new Promise((resolve, reject) => {
      const listener = getApp().listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    server.unref();
  }
  const address = server.address();
  const testAgent = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    cookies: new Map(),
    csrfToken: '',
    get(url) { return new TestRequest(this, 'GET', url); },
    post(url) { return new TestRequest(this, 'POST', url); },
    put(url) { return new TestRequest(this, 'PUT', url); },
    delete(url) { return new TestRequest(this, 'DELETE', url); },
  };
  await testAgent.get('/login/').expect(200);
  return testAgent;
}

/*
  Per-suite teardown: stops listening and puts the environment back, leaving the
  database and the session store for whoever runs next.

  close() cannot do this job, because it closes the sequelize connection while
  ready() keeps its promise memoised - so the second suite to call close() finds
  a dead connection ("getConnection was called after the connection manager was
  closed"). That made close() something only the last suite in the process could
  call, which in turn meant every other suite left DISABLE_AUTH_RATE_LIMIT set:
  the rate-limiter specs in t/unit/middleware/auth_security.js build their own
  limiters and then find nothing is ever blocked.

  Nothing here holds the event loop open - the listener is unref'd and the
  database is in memory - so a suite that only releases still lets the process
  exit.
*/
async function release() {
  if (server) {
    const activeServer = server;
    server = null;
    await new Promise(resolve => {
      activeServer.close(resolve);
      if (typeof activeServer.closeAllConnections === 'function') {
        activeServer.closeAllConnections();
      }
    });
  }
  restoreTestEnv();
}

async function close() {
  await release();
  if (app) {
    const sessionMiddleware = app.get('session_middleware');
    if (sessionMiddleware && typeof sessionMiddleware.close === 'function') {
      sessionMiddleware.close();
    }
    await app.get('db_model').sequelize.close();
  }
}

module.exports = {
  agent,
  close,
  getApp,
  ready,
  release,
};
