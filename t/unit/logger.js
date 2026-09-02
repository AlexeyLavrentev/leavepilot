'use strict';

const { expect } = require('chai');
const requestContext = require('../../lib/middleware/request_context');
const originalLogLevel = process.env.LOG_LEVEL;

const loadLogger = () => {
  process.env.LOG_LEVEL = 'debug';
  const modulePath = require.resolve('../../lib/logger');
  delete require.cache[modulePath];
  return require('../../lib/logger');
};

const captureConsole = callback => {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const calls = [];

  console.log = line => calls.push({ stream: 'stdout', line });
  console.warn = line => calls.push({ stream: 'stderr', line });
  console.error = line => calls.push({ stream: 'stderr', line });

  try {
    callback();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  return calls;
};

describe('public logger', () => {
  after(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it('keeps level, stream, request correlation, and protected JSON fields', async () => {
    const logger = loadLogger();
    const calls = await requestContext.run({ requestId: 'public-request-1' }, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return captureConsole(() => {
        logger.info('event_name', {
          time: 'forged-time',
          level: 'forged-level',
          msg: 'forged-msg',
          event: 'forged-event',
        });
        logger.error('failure');
      });
    });

    expect(calls).to.have.lengthOf(2);
    const info = JSON.parse(calls[0].line);
    const error = JSON.parse(calls[1].line);
    expect(calls[0].stream).to.equal('stdout');
    expect(calls[1].stream).to.equal('stderr');
    expect(info).to.include({ level: 'info', msg: 'event_name', event: 'event_name', requestId: 'public-request-1' });
    expect(info.time).to.not.equal('forged-time');
    expect(error).to.include({ level: 'error', msg: 'failure', event: 'failure', requestId: 'public-request-1' });
  });

  it('redacts nested secrets and serializes difficult values without throwing', () => {
    const logger = loadLogger();
    const circular = { password: 'nested-password', count: 10n };
    circular.self = circular;

    const calls = captureConsole(() => {
      logger.warn('safe_event', {
        authorization: 'Bearer top-secret-token',
        nested: circular,
        error: new Error('safe error'),
      });
    });
    const parsed = JSON.parse(calls[0].line);
    const output = JSON.stringify(parsed);

    expect(parsed.authorization).to.equal('[REDACTED]');
    expect(parsed.nested.password).to.equal('[REDACTED]');
    expect(parsed.nested.count).to.equal('10');
    expect(parsed.nested.self).to.equal('[Circular]');
    expect(parsed.error.message).to.equal('safe error');
    expect(output).to.not.contain('top-secret-token');
    expect(output).to.not.contain('nested-password');
  });

  it('never propagates a logging stream failure', () => {
    const logger = loadLogger();
    const original = console.error;

    console.error = () => { throw new Error('broken stream'); };
    try {
      expect(() => logger.error('non_fatal_log')).to.not.throw();
    } finally {
      console.error = original;
    }
  });
});
