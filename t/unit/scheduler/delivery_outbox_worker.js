'use strict';

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const {Op} = require('sequelize');

const worker = require('../../../lib/scheduler/delivery_outbox_worker');
const EditionRegistry = require('../../../lib/edition/registry');

const SECOND = 1000;
const BEYOND_BACKOFF_CAP_MS = 31 * SECOND;

function captureLogger() {
  const events = [];
  return {
    events,
    debug : function(message, meta) { events.push({level: 'debug', message, meta}); },
    info  : function(message, meta) { events.push({level: 'info', message, meta}); },
    error : function(message, meta) { events.push({level: 'error', message, meta}); },
  };
}

/*
  In-memory DeliveryOutbox table: interprets the Sequelize where shapes the
  domain module issues (status plain or Op.in, nextAttemptAt Op.lte,
  deliveredAt Op.lt) so multi-sweep scenarios observe real row state.
*/
function fakeOutboxModel(rows) {
  const state = {
    rows          : rows.map(row => Object.assign({}, row)),
    findAllWheres : [],
    updates       : [],
  };

  return {
    state,

    DeliveryOutbox : {
      findAll : async function(args) {
        state.findAllWheres.push(args);
        const where = args.where;
        const now = where.nextAttemptAt ? where.nextAttemptAt[Op.lte] : null;
        const horizon = where.deliveredAt ? where.deliveredAt[Op.lt] : null;
        const statuses = where.status && where.status[Op.in]
          ? where.status[Op.in]
          : [where.status];

        const due = state.rows
          .filter(row => statuses.indexOf(row.status) !== -1)
          .filter(row => !now || row.nextAttemptAt.getTime() <= now.getTime())
          .filter(row => !horizon
            || (row.deliveredAt && row.deliveredAt.getTime() < horizon.getTime()))
          .sort((a, b) => a.id - b.id);

        const limited = args.limit ? due.slice(0, args.limit) : due;
        return limited.map(row => Object.assign({}, row));
      },

      update : async function(values, args) {
        state.updates.push({values, args});
        const row = state.rows.find(candidate => candidate.id === args.where.id);
        if (!row) {
          return [0];
        }
        if (Object.prototype.hasOwnProperty.call(args.where, 'attempts')
          && row.attempts !== args.where.attempts) {
          return [0];
        }
        Object.assign(row, values);
        return [1];
      },

      destroy : async function(args) {
        const ids = args.where.id;
        const before = state.rows.length;
        state.rows = state.rows.filter(row => ids.indexOf(row.id) === -1);
        return before - state.rows.length;
      },
    },
  };
}

// ScheduledTaskLock stub whose locks are always acquirable.
function acquirableLockModel() {
  const calls = {findOne: 0, create: 0};
  return {
    calls,
    ScheduledTaskLock : {
      findOne : async function() {
        calls.findOne += 1;
        return null;
      },
      create : async function(payload) {
        calls.create += 1;
        return Object.assign({save: async function() {}}, payload);
      },
    },
  };
}

// ScheduledTaskLock stub whose single pre-existing lock never expires.
function heldLockModel() {
  const calls = {findOne: 0};
  return {
    calls,
    ScheduledTaskLock : {
      findOne : async function() {
        calls.findOne += 1;
        return {
          locked_until : new Date('2099-01-01T00:00:00Z'),
          locked_by    : 'other-owner',
        };
      },
    },
  };
}

function buildModels({rows}) {
  const outbox = fakeOutboxModel(rows);
  const locks = acquirableLockModel();
  return {
    rows         : outbox.state.rows,
    findAllWheres: outbox.state.findAllWheres,
    lockCalls    : locks.calls,
    models       : Object.assign({}, outbox, locks),
  };
}

const resolvingExecutor = {
  deliveryType : 'email',
  deliver      : async function() {},
};

const rejectingExecutor = {
  deliveryType : 'email',
  deliver      : function() {
    return Promise.reject(new Error('synthetic smtp outage'));
  },
};

describe('Delivery outbox worker', function() {

  describe('runDeliveryOutboxOnce', function() {

    it('delivers a due record through the resolving executor and marks it delivered', async function() {
      const now = new Date('2026-10-02T12:00:00Z');
      const harness = buildModels({
        rows: [{
          id            : 1,
          deliveryType  : 'email',
          eventType     : 'submitted',
          payload       : JSON.stringify({leaveId: 11}),
          status        : 'pending',
          attempts      : 0,
          nextAttemptAt : new Date(now.getTime() - 1000),
        }],
      });
      const logger = captureLogger();

      const result = await worker.runDeliveryOutboxOnce({
        models          : harness.models,
        logger,
        now,
        resolveExecutor : () => resolvingExecutor,
      });

      expect(result.skipped).to.equal(false);
      expect(result.claimed).to.equal(1);
      expect(result.delivered).to.equal(1);
      expect(result.failed).to.equal(0);
      expect(harness.rows[0].status).to.equal('delivered');
      expect(harness.rows[0].deliveredAt.getTime()).to.equal(now.getTime());
      expect(harness.rows[0].attempts).to.equal(1);
    });

    it('sweeps only pending records when includeFailed is not set (D-11)', async function() {
      const now = new Date('2026-10-02T12:00:00Z');
      const harness = buildModels({
        rows: [
          {
            id: 1, deliveryType: 'email', eventType: 'submitted',
            payload: '{}', status: 'pending', attempts: 0,
            nextAttemptAt: new Date(now.getTime() - 1000),
          },
          {
            id: 2, deliveryType: 'email', eventType: 'approve',
            payload: '{}', status: 'failed', attempts: 5,
            nextAttemptAt: new Date(now.getTime() - 1000),
          },
        ],
      });

      const result = await worker.runDeliveryOutboxOnce({
        models          : harness.models,
        logger          : captureLogger(),
        now,
        resolveExecutor : () => resolvingExecutor,
      });

      expect(result.claimed).to.equal(1);
      expect(harness.rows[0].status).to.equal('delivered');
      expect(harness.rows[1].status).to.equal('failed');
      expect(harness.rows[1].attempts).to.equal(5);
    });

    it('re-arms failed records when includeFailed is set (D-11 restart re-arm)', async function() {
      const now = new Date('2026-10-02T12:00:00Z');
      const harness = buildModels({
        rows: [
          {
            id: 1, deliveryType: 'email', eventType: 'submitted',
            payload: '{}', status: 'pending', attempts: 0,
            nextAttemptAt: new Date(now.getTime() - 1000),
          },
          {
            id: 2, deliveryType: 'email', eventType: 'approve',
            payload: '{}', status: 'failed', attempts: 5,
            nextAttemptAt: new Date(now.getTime() - 1000),
          },
        ],
      });

      const result = await worker.runDeliveryOutboxOnce({
        models          : harness.models,
        logger          : captureLogger(),
        now,
        includeFailed   : true,
        resolveExecutor : () => resolvingExecutor,
      });

      expect(result.claimed).to.equal(2);
      expect(result.delivered).to.equal(2);
      expect(harness.rows[1].status).to.equal('delivered');
      expect(harness.rows[1].attempts).to.equal(6);
    });

    it('stops after exactly 5 attempts: terminal failed, one delivery_exhausted, later sweeps never touch it (D-03)', async function() {
      const start = new Date('2026-10-02T12:00:00Z');
      const harness = buildModels({
        rows: [{
          id            : 1,
          deliveryType  : 'email',
          eventType     : 'submitted',
          payload       : JSON.stringify({leaveId: 11}),
          status        : 'pending',
          attempts      : 0,
          nextAttemptAt : new Date(start.getTime() - 1000),
        }],
      });
      const logger = captureLogger();
      const clock = {at: new Date(start.getTime())};

      for (let sweep = 1; sweep <= 5; sweep += 1) {
        const result = await worker.runDeliveryOutboxOnce({
          models          : harness.models,
          logger,
          now             : clock.at,
          resolveExecutor : () => rejectingExecutor,
        });

        expect(result.claimed).to.equal(1);
        expect(result.failed).to.equal(1);
        expect(harness.rows[0].attempts).to.equal(sweep);
        // advance past the 30s backoff cap so the row is due again
        clock.at = new Date(clock.at.getTime() + BEYOND_BACKOFF_CAP_MS);
      }

      expect(harness.rows[0].status).to.equal('failed');
      expect(harness.rows[0].lastError).to.equal('synthetic smtp outage');

      const exhausted = logger.events.filter(event => event.message === 'delivery_exhausted');
      expect(exhausted.length).to.equal(1);
      expect(exhausted[0].meta.attempts).to.equal(5);

      // sweeps 6+ never touch the terminal record
      const updatesBefore = harness.findAllWheres.length;
      for (let sweep = 6; sweep <= 7; sweep += 1) {
        const result = await worker.runDeliveryOutboxOnce({
          models          : harness.models,
          logger,
          now             : clock.at,
          resolveExecutor : () => rejectingExecutor,
        });
        expect(result.claimed).to.equal(0);
        clock.at = new Date(clock.at.getTime() + BEYOND_BACKOFF_CAP_MS);
      }
      expect(harness.rows[0].attempts).to.equal(5);
      expect(
        logger.events.filter(event => event.message === 'delivery_exhausted').length
      ).to.equal(1);
      expect(harness.findAllWheres.length).to.be.above(updatesBefore - 1);
    });

    it('logs delivery_attempt_failed with ids/type/attempts and err.message only, never payload (D-08/MUT-02)', async function() {
      const now = new Date('2026-10-02T12:00:00Z');
      const harness = buildModels({
        rows: [{
          id            : 1,
          deliveryType  : 'email',
          eventType     : 'submitted',
          payload       : JSON.stringify({leaveId: 11}),
          status        : 'pending',
          attempts      : 0,
          nextAttemptAt : new Date(now.getTime() - 1000),
        }],
      });
      const logger = captureLogger();

      await worker.runDeliveryOutboxOnce({
        models          : harness.models,
        logger,
        now,
        resolveExecutor : () => rejectingExecutor,
      });

      const failures = logger.events.filter(event => event.message === 'delivery_attempt_failed');
      expect(failures.length).to.equal(1);

      const meta = failures[0].meta;
      expect(Object.keys(meta).sort()).to.deep.equal(['attempts', 'err', 'event_type', 'id', 'type']);
      expect(meta.id).to.equal(1);
      expect(meta.type).to.equal('email');
      expect(meta.event_type).to.equal('submitted');
      expect(meta.attempts).to.equal(1);
      expect(meta.err).to.equal('synthetic smtp outage');

      const serialized = JSON.stringify(logger.events);
      expect(serialized).to.not.contain('leaveId');
      expect(serialized).to.not.contain('payload');
      expect(serialized).to.not.contain('body');
      expect(serialized).to.not.contain('subject');
    });

    it('treats a delivery type with no registered executor as a failed attempt with delivery_executor_missing (D-09)', async function() {
      const now = new Date('2026-10-02T12:00:00Z');
      const harness = buildModels({
        rows: [{
          id            : 1,
          deliveryType  : 'premium_webhook',
          eventType     : 'submitted',
          payload       : '{}',
          status        : 'pending',
          attempts      : 0,
          nextAttemptAt : new Date(now.getTime() - 1000),
        }],
      });
      const logger = captureLogger();

      const result = await worker.runDeliveryOutboxOnce({
        models          : harness.models,
        logger,
        now,
        resolveExecutor : () => null,
      });

      expect(result.failed).to.equal(1);
      expect(result.delivered).to.equal(0);

      const missing = logger.events.filter(event => event.message === 'delivery_executor_missing');
      expect(missing.length).to.equal(1);
      expect(missing[0].meta.type).to.equal('premium_webhook');
      // attempt 1 of 5: not exhausted yet, the row stays pending with a
      // pre-scheduled retry
      expect(harness.rows[0].status).to.equal('pending');
      expect(
        logger.events.filter(event => event.message === 'delivery_exhausted').length
      ).to.equal(0);
    });

    it('is a no-op returning skipped when the sweep lock is held (D-05)', async function() {
      const now = new Date('2026-10-02T12:00:00Z');
      const outbox = fakeOutboxModel([{
        id: 1, deliveryType: 'email', eventType: 'submitted', payload: '{}',
        status: 'pending', attempts: 0, nextAttemptAt: new Date(now.getTime() - 1000),
      }]);
      const locks = heldLockModel();
      const logger = captureLogger();

      const result = await worker.runDeliveryOutboxOnce({
        models          : Object.assign({}, outbox, locks),
        logger,
        now,
        resolveExecutor : () => resolvingExecutor,
      });

      expect(result.skipped).to.equal(true);
      expect(locks.calls.findOne).to.equal(1);
      expect(outbox.state.findAllWheres.length).to.equal(0);
      expect(outbox.state.rows[0].status).to.equal('pending');
    });
  });

  describe('startDeliveryOutboxWorker', function() {

    it('runs the first sweep immediately and re-arms failed records (D-02 startup catch-up)', async function() {
      const now = new Date();
      const harness = buildModels({
        rows: [{
          id: 1, deliveryType: 'email', eventType: 'submitted', payload: '{}',
          status: 'failed', attempts: 5,
          nextAttemptAt: new Date(now.getTime() - 1000),
        }],
      });

      const handle = worker.startDeliveryOutboxWorker({
        models          : harness.models,
        logger          : captureLogger(),
        tickMs          : 5000,
        resolveExecutor : () => resolvingExecutor,
      });

      // stop() drains the active job: awaiting it proves the immediate
      // startup sweep completed before any tick fired.
      await handle.stop();

      expect(harness.rows[0].status).to.equal('delivered');
      const firstWhere = harness.findAllWheres[0];
      expect(firstWhere.status[Op.in]).to.deep.equal(['pending', 'failed']);
    });

    it('honors tickMs for subsequent sweeps and stop() clears the timer', async function() {
      const locks = heldLockModel();
      const logger = captureLogger();

      const handle = worker.startDeliveryOutboxWorker({
        models : {ScheduledTaskLock: locks.ScheduledTaskLock},
        logger,
        tickMs : 25,
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(locks.calls.findOne).to.equal(1);

      await new Promise(resolve => setTimeout(resolve, 80));
      expect(locks.calls.findOne).to.be.at.least(2);

      await handle.stop();
      const countAtStop = locks.calls.findOne;

      await new Promise(resolve => setTimeout(resolve, 80));
      expect(locks.calls.findOne).to.equal(countAtStop);
    });

    it('contains no reminder feature-flag gate (always-on per D-05)', function() {
      const source = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'lib', 'scheduler', 'delivery_outbox_worker.js'),
        'utf8'
      );

      expect(source).to.not.contain('LEAVE_REMINDER_SCHEDULER_ENABLED');
      expect(source).to.not.contain('isSchedulerEnabled');
    });
  });

  describe('edition registry delivery executor seam (D-09/D-10)', function() {

    it('rejects an executor without a deliveryType or deliver function', function() {
      const registry = new EditionRegistry();

      expect(() => registry.registerDeliveryExecutor({})).to.throw(Error);
      expect(() => registry.registerDeliveryExecutor({deliveryType: 'email'})).to.throw(Error);
      expect(() => registry.registerDeliveryExecutor({deliver: async function() {}})).to.throw(Error);
    });

    it('rejects registering the same deliveryType twice', function() {
      const registry = new EditionRegistry();
      registry.registerDeliveryExecutor({
        deliveryType : 'email',
        deliver      : async function() {},
      });

      expect(() => registry.registerDeliveryExecutor({
        deliveryType : 'email',
        deliver      : async function() {},
      })).to.throw(Error);
    });

    it('returns the registered executor or null', function() {
      const registry = new EditionRegistry();
      const executor = {deliveryType: 'edition_event', deliver: async function() {}};
      registry.registerDeliveryExecutor(executor);

      expect(registry.getDeliveryExecutor('edition_event')).to.equal(executor);
      expect(registry.getDeliveryExecutor('email')).to.equal(null);
    });
  });
});
