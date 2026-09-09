'use strict';

var expect = require('chai').expect;
var logger = require('../../../lib/middleware/request_logger');
var requestContext = require('../../../lib/middleware/request_context');

describe('Structured logger (request_logger)', function() {

  describe('levels', function() {

    it('respects LOG_LEVEL filtering', function() {
      var originalLevel = logger._getLevel();
      try {
        // Set to warn — debug and info should be suppressed
        logger._setLevel(30);

        expect(logger._shouldLog('debug')).to.equal(false);
        expect(logger._shouldLog('info')).to.equal(false);
        expect(logger._shouldLog('warn')).to.equal(true);
        expect(logger._shouldLog('error')).to.equal(true);
      } finally {
        logger._setLevel(originalLevel);
      }
    });
  });

  describe('format', function() {

    it('produces valid JSON with time, level, msg', function() {
      var line = logger._format('info', 'test message');

      var parsed = JSON.parse(line);
      expect(parsed.level).to.equal('info');
      expect(parsed.msg).to.equal('test message');
      expect(parsed.time).to.be.a('string');
    });

    it('merges extra metadata fields', function() {
      var line = logger._format('error', 'boom', {
        requestId: 'abc-123',
        code: 'ECONNREFUSED',
      });

      var parsed = JSON.parse(line);
      expect(parsed.requestId).to.equal('abc-123');
      expect(parsed.code).to.equal('ECONNREFUSED');
    });

    it('does not allow reserved keys to be overwritten by metadata', function() {
      var line = logger._format('info', 'msg', {
        time: 'fake-time',
        level: 'fake-level',
        msg: 'fake-msg',
      });

      var parsed = JSON.parse(line);
      expect(parsed.time).to.not.equal('fake-time');
      expect(parsed.level).to.equal('info');
      expect(parsed.msg).to.equal('msg');
    });

    it('stringifies non-string messages', function() {
      var line = logger._format('info', 42);
      expect(JSON.parse(line).msg).to.equal('42');
    });

    it('redacts nested secrets and safely serializes difficult values', function() {
      var circular = {password: 'hidden', count: 10n};
      circular.self = circular;
      var parsed = JSON.parse(logger._format('error', 'safe', {
        authorization: 'Bearer token-value',
        nested: circular,
        error: new Error('boom'),
      }));

      expect(parsed.authorization).to.equal('[REDACTED]');
      expect(parsed.nested.password).to.equal('[REDACTED]');
      expect(parsed.nested.count).to.equal('10');
      expect(parsed.nested.self).to.equal('[Circular]');
      expect(parsed.error.message).to.equal('boom');
      expect(JSON.stringify(parsed)).to.not.contain('token-value');
      expect(JSON.stringify(parsed)).to.not.contain('hidden');
    });

    it('retains request context across asynchronous boundaries', async function() {
      var parsed = await requestContext.run({requestId: 'async-request-1'}, async function() {
        await new Promise(resolve => setTimeout(resolve, 1));
        return JSON.parse(logger._format('info', 'async_event'));
      });
      expect(parsed.requestId).to.equal('async-request-1');
    });
  });

  describe('child logger', function() {
    var originalLevel;

    beforeEach(function() {
      originalLevel = logger._getLevel();
      logger._setLevel(20);
    });

    afterEach(function() {
      logger._setLevel(originalLevel);
    });

    it('attaches metadata to every log call', function() {
      var originalWrite = process.stdout.write.bind(process.stdout);
      var captured = [];

      process.stdout.write = function(chunk) {
        captured.push(chunk);
        return true;
      };

      try {
        var child = logger.child({ requestId: 'req-child-1' });
        child.info('child message', { extra: 'value' });

        expect(captured.length).to.be.greaterThan(0);
        var parsed = JSON.parse(captured[captured.length - 1]);
        expect(parsed.requestId).to.equal('req-child-1');
        expect(parsed.extra).to.equal('value');
        expect(parsed.msg).to.equal('child message');
      } finally {
        process.stdout.write = originalWrite;
      }
    });

    it('allows ordinary extra metadata to override child metadata but locks requestId', function() {
      var originalWrite = process.stdout.write.bind(process.stdout);
      var captured = [];

      process.stdout.write = function(chunk) {
        captured.push(chunk);
        return true;
      };

      try {
        var child = logger.child({ requestId: 'base-id', tag: 'original' });
        child.info('msg', { tag: 'overridden', requestId: 'forged-id' });

        var parsed = JSON.parse(captured[captured.length - 1]);
        expect(parsed.tag).to.equal('overridden');
        expect(parsed.requestId).to.equal('base-id');
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  describe('untrusted output boundary', function() {
    it('redacts credentials in errors, free text, event and request correlation', function() {
      const marker = 'structured-output-sentinel';
      const parsed = JSON.parse(logger._format('error', `failure password=${marker}`, {
        requestId: `token=${marker}`,
        api_key: marker,
        error: new Error(`connect mysql://user:${marker}@db.example/test`),
        details: [`Authorization: Bearer ${marker}\ncontinued`, {note: `api_key=${marker}`}],
      }));
      expect(JSON.stringify(parsed)).not.to.contain(marker);
      expect(parsed.msg).to.equal('failure password=[REDACTED]');
      expect(parsed.error.message).to.equal('connect [REDACTED]');
      expect(parsed.details[1].note).to.equal('api_key=[REDACTED]');
    });

    it('bounds long text and total JSON bytes including escaped control characters', function() {
      const meta = Object.fromEntries(Array.from({length: 100}, (_, i) => [`field${i}`, '\u0000'.repeat(100000)]));
      const line = logger._format('info', 'bounded_event', meta);
      expect(Buffer.byteLength(line)).to.be.at.most(65536);
      const parsed = JSON.parse(line);
      expect(parsed.event).to.equal('bounded_event');
      expect(parsed.field0.length).to.be.at.most(2060);
      expect(line).to.include('[Truncated]');
    });

    it('bounds recursion without a stack overflow and marks omitted content', function() {
      let nested = {value: 'leaf'};
      for (let i = 0; i < 5000; i++) {nested = {nested};}
      let line;
      expect(() => {line = logger._format('info', 'deep', {nested});}).not.to.throw();
      expect(Buffer.byteLength(line)).to.be.at.most(65536);
      expect(line).to.include('[Truncated]');
    });

    it('does not inspect array entries past the collection limit', function() {
      const items = Array(10000).fill('safe');
      Object.defineProperty(items, 100, {get() {throw new Error('must not inspect');}});
      const parsed = JSON.parse(logger._format('info', 'wide', {items}));
      expect(parsed.items.length).to.be.at.most(33);
      expect(parsed.items.at(-1)).to.equal('[Truncated]');
    });

    it('bounds object traversal and does not execute JSON serialization hooks', function() {
      const details = Object.fromEntries(Array.from({length: 100}, (_, i) => [`key${i}`, i]));
      Object.defineProperty(details, 'late', {enumerable: true, get() {throw new Error('must not inspect');}});
      const hook = JSON.parse('{"__proto__":{"polluted":true},"ok":"safe"}');
      hook.toJSON = () => {throw new Error('must not execute');};
      const parsed = JSON.parse(logger._format('info', 'objects', {details, hook}));
      expect(Object.keys(parsed.details).length).to.be.at.most(33);
      expect(parsed.hook.ok).to.equal('safe');
      expect({}.polluted).to.equal(undefined);
    });

    it('keeps ignored reserved getters and oversized field names out of traversal', function() {
      const meta = {ok: 'safe', get event() {throw new Error('ignored reserved field');}};
      Object.defineProperty(meta, 'x'.repeat(10000), {
        enumerable: true, get() {throw new Error('oversized key');},
      });
      const parsed = JSON.parse(logger._format('info', 'owned_event', meta));
      expect(parsed.event).to.equal('owned_event');
      expect(parsed.ok).to.equal('safe');
      expect(parsed['[Truncated]']).to.equal(true);
    });

    it('bounds aggregate node traversal across many small nested fields', function() {
      let reads = 0;
      const metadata = Array.from({length: 32}, () => Array.from({length: 32}, () => ({
        get value() {reads++; return 1;},
      })));
      const line = logger._format('info', 'many_nodes', {metadata});
      expect(reads).to.be.at.most(256);
      expect(line).to.include('[Truncated]');
      expect(Buffer.byteLength(line)).to.be.at.most(65536);
    });

    it('does not leak a thrown getter error through its fallback record', function() {
      const originalWrite = process.stderr.write;
      const originalLevel = logger._getLevel();
      const lines = [];
      try {
        logger._setLevel(10);
        process.stderr.write = line => {lines.push(line); return true;};
        const meta = {get details() {throw new Error('password=fallback-sentinel');}};
        logger.error('bad_metadata', meta);
      } finally {
        process.stderr.write = originalWrite;
        logger._setLevel(originalLevel);
      }
      expect(lines).to.have.lengthOf(1);
      expect(lines[0]).not.to.contain('fallback-sentinel');
      expect(JSON.parse(lines[0]).event).to.equal('log_serialization_failed');
    });
  });
});
