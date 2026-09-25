'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {randomBytes} = require('crypto');
const Sequelize = require('sequelize');
const {spawnInGroup, terminateGroup} = require('../../../bin/lib/spawn_group');

const dialect = process.env.TEST_DB_DIALECT === 'mysql' ? 'mysql' : 'sqlite';
const fixture = path.resolve(__dirname, '../../fixtures/runtime/session_store_case.js');

function runCase(env, mode, deadlineMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawnInGroup(process.execPath, [fixture, mode], {
      env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = chunk => { output = (output + chunk.toString()).slice(-8192); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateGroup(child, {graceMs: 500}).catch(reject);
    }, deadlineMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) { return reject(new Error(`${mode} child exceeded ${deadlineMs}ms`)); }
      if (code !== 0) { return reject(new Error(`${mode} child exited ${code}: ${output}`)); }
      try {
        resolve(JSON.parse(output.trim().split('\n').at(-1)));
      } catch (error) { reject(new Error(`${mode} child did not report a verdict: ${error.message}`)); }
    });
  });
}

describe(`public SQL session Store contract (${dialect})`, function() {
  it('keeps current and native Stores readable across restart, and exercises real HTTP login/logout', async function() {
    this.timeout(45000);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-session-contract-'));
    const database = 'lp_session_' + randomBytes(12).toString('hex');
    const env = {
      NODE_ENV: 'test', TEST_DB_DIALECT: dialect, DB_DIALECT: dialect,
      DB_STORAGE: path.join(directory, 'sessions.sqlite'), DB_NAME: database,
      DB_HOST: process.env.DB_HOST || '127.0.0.1', DB_PORT: process.env.DB_PORT || '3306',
      DB_USER: process.env.DB_USER || 'root', DB_PASSWORD: process.env.DB_PASSWORD || '',
      DB_LOGGING: 'false', SESSION_SECRET: 'contract-only-session-secret',
      CRYPTO_SECRET: 'contract-only-crypto-secret', LEAVEPILOT_EDITION: 'community',
      SILENCE_HTTP_LOGS: 'true', DISABLE_AUTH_RATE_LIMIT: 'true',
      DISABLE_NOTIFICATIONS_POLLING: 'true',
    };
    let maintenance;
    let created = false;
    try {
      if (dialect === 'mysql') {
        maintenance = new Sequelize(process.env.DB_NAME, env.DB_USER, env.DB_PASSWORD, {
          dialect, host: env.DB_HOST, port: env.DB_PORT, logging: false,
          dialectOptions: {connectTimeout: 5000},
        });
        await maintenance.query('CREATE DATABASE `' + database + '`');
        created = true;
      }
      const result = await runCase(env, 'store');
      assert.equal(result.dialect, dialect);
      assert.deepEqual(result.stores, ['current', 'native', 'current']);
      assert.equal(result.publicContract, true);
      assert.equal(result.crossRestart, true);
      assert.equal(result.httpLoginLogout, true);
      assert.equal(result.cookieContract, true);
      const secure = await runCase({...env, TEST_COOKIE_SECURE: 'true',
        SESSION_COOKIE_SECURE: 'true', SESSION_COOKIE_SAME_SITE: 'none',
        SESSION_COOKIE_MAX_AGE_MS: '3600000', TRUST_PROXY: 'true'}, 'http-secure');
      assert.equal(secure.httpLoginLogout, true);
      assert.equal(secure.cookieContract, true);
      console.log(JSON.stringify({dialect, observations: result.observations,
        defaultCookie: true, secureProxyCookie: true}));
    } finally {
      if (maintenance) {
        try { if (created) { await maintenance.query('DROP DATABASE `' + database + '`'); } }
        finally { await maintenance.close(); }
      }
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('makes the existing HTTP helper wait for session readiness after schema preparation', async function() {
    this.timeout(15000);
    const verdict = await runCase({NODE_ENV: 'test'}, 'http-agent-ready', 10000);
    assert.equal(verdict.httpAgentReady, true);
  });
});
