'use strict';

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createSessionLifecycle} = require('../../../lib/middleware/session_lifecycle');

function fixture(options = {}) {
  const client = new EventEmitter();
  client.isOpen = true;
  client.connect = async () => {};
  client.close = async () => { client.isOpen = false; };
  client.destroy = () => { client.isOpen = false; client.destroyed = true; };
  const values = new Map();
  const calls = [];
  const handlers = {};
  const store = {
    set(sid, value, callback) { calls.push('set'); if (handlers.set) { return handlers.set(sid, value, callback); } values.set(sid, value); callback(null); },
    get(sid, callback) { calls.push('get'); if (handlers.get) { return handlers.get(sid, callback); } callback(null, values.get(sid)); },
    touch(sid, value, callback) { calls.push('touch'); if (handlers.touch) { return handlers.touch(sid, value, callback); } callback(null); },
    destroy(sid, callback) { calls.push('destroy'); if (handlers.destroy) { return handlers.destroy(sid, callback); } values.delete(sid); callback(null); },
  };
  const logs = [];
  const logger = {error: (...args) => logs.push(args), warn: (...args) => logs.push(args)};
  const lifecycle = createSessionLifecycle({store, client, logger, recoveryTimeoutMs: 80,
    operationTimeoutMs: 20, closeTimeoutMs: 20, ...options});
  return {client, store, lifecycle, values, calls, logs, handlers};
}

async function until(predicate, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), 'condition did not become true');
}

describe('selected Redis session lifecycle', function() {
  it('keeps the first outage deadline through repeated reconnects and failed probes', async function() {
    const test = fixture();
    try {
      await test.lifecycle.initialize();
      const states = [];
      test.lifecycle.onStateChange(event => states.push(event.state));
      test.client.emit('error', Object.assign(new Error('private transport detail'), {code: 'ECONNRESET'}));
      test.handlers.set = (_sid, _value, callback) => callback(new Error('NOPERM denied'));
      for (let i = 0; i < 3; i++) {
        test.client.emit('ready');
        test.client.emit('error', Object.assign(new Error('private transport detail'), {code: 'ECONNRESET'}));
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.equal(test.lifecycle.isReady(), false);
      await until(() => states.includes('failed'), 150);
      assert.equal(states.filter(state => state === 'failed').length, 1);
      test.client.emit('ready');
      assert.equal(test.lifecycle.isReady(), false);
      assert.ok(test.client.destroyed);
      assert.doesNotMatch(JSON.stringify(test.logs), /private transport detail|NOPERM denied/);
    } finally { await test.lifecycle.close(); }
  });

  it('bounds a blackholed in-flight Store command and calls its callback once', async function() {
    const test = fixture();
    try {
      await test.lifecycle.initialize();
      let late;
      test.handlers.get = (_sid, callback) => { late = callback; };
      const results = [];
      test.store.get('real-session', error => results.push(error));
      await until(() => results.length === 1);
      assert.equal(results[0].code, 'SESSION_STORE_UNAVAILABLE');
      assert.equal(test.lifecycle.isReady(), false);
      late(null, {authenticated: true});
      assert.equal(results.length, 1);
    } finally { await test.lifecycle.close(); }
  });

  it('coalesces ready events into one probe and ignores completion after close', async function() {
    const test = fixture();
    try {
      await test.lifecycle.initialize();
      test.client.emit('error', Object.assign(new Error('lost'), {code: 'ECONNRESET'}));
      let pending;
      let writes = 0;
      test.handlers.set = (_sid, _value, callback) => { writes++; pending = callback; };
      test.client.emit('ready');
      test.client.emit('ready');
      await until(() => writes === 1);
      await test.lifecycle.close();
      pending(null);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(writes, 1);
      assert.equal(test.lifecycle.isReady(), false);
    } finally { await test.lifecycle.close(); }
  });

  it('fails startup promptly on Redis permission errors without leaking the message', async function() {
    const test = fixture();
    test.client.connect = async () => { throw new Error('WRONGPASS private credential'); };
    await assert.rejects(test.lifecycle.initialize(), /session_store_permission/);
    assert.equal(test.lifecycle.isReady(), false);
    assert.ok(test.client.destroyed);
    assert.doesNotMatch(JSON.stringify(test.logs), /private credential/);
    await test.lifecycle.close();
  });
});
