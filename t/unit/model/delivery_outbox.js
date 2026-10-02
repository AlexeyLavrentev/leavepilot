'use strict';

const expect = require('chai').expect;
const {Op} = require('sequelize');

const deliveryOutbox = require('../../../lib/model/delivery_outbox');

describe('Delivery outbox domain module', function() {

  describe('enqueue', function() {

    it('inserts every record on the caller transaction with pending status and due-now schedule', async function() {
      const creates = [];
      const transaction = {id: 'tx-1'};
      const models = {
        DeliveryOutbox : {
          create : function(values, options) {
            creates.push({values, options});
            return Promise.resolve(values);
          },
        },
      };

      await deliveryOutbox.enqueue({
        models,
        transaction,
        records : [
          {
            deliveryType : 'email',
            eventType    : 'submitted',
            companyId    : 1,
            userId       : 7,
            payload      : {leaveId: 11},
          },
          {
            deliveryType : 'edition_event',
            eventType    : 'submitted',
            companyId    : 1,
            userId       : 7,
            payload      : {leaveId: 11},
          },
        ],
      });

      expect(creates.length).to.equal(2);
      creates.forEach(function(entry) {
        expect(entry.options.transaction).to.equal(transaction);
        expect(entry.values.status).to.equal('pending');
        expect(entry.values.attempts).to.equal(0);
        expect(entry.values.nextAttemptAt).to.be.an.instanceOf(Date);
      });
      expect(creates[0].values.deliveryType).to.equal('email');
      expect(creates[0].values.eventType).to.equal('submitted');
      expect(creates[0].values.companyId).to.equal(1);
      expect(creates[0].values.userId).to.equal(7);
      expect(creates[0].values.payload).to.equal(JSON.stringify({leaveId: 11}));
      expect(creates[1].values.deliveryType).to.equal('edition_event');
    });

    it('stringifies the payload as JSON of references only', async function() {
      const creates = [];
      const models = {
        DeliveryOutbox : {
          create : function(values, options) {
            creates.push({values, options});
            return Promise.resolve(values);
          },
        },
      };

      await deliveryOutbox.enqueue({
        models,
        transaction : {id: 'tx-2'},
        records     : [{
          deliveryType : 'email',
          eventType    : 'approve',
          companyId    : 2,
          userId       : 8,
          payload      : {leaveId: 12, action: 'approve', wasPendedRevoke: false},
        }],
      });

      expect(creates[0].values.payload).to.equal(
        JSON.stringify({leaveId: 12, action: 'approve', wasPendedRevoke: false})
      );
    });
  });

  describe('nextAttemptDate', function() {

    it('yields delays within [1000, 30000] ms, monotonically non-decreasing and capped', function() {
      const now = new Date('2026-10-02T12:00:00Z');
      let previous = -Infinity;

      [1, 2, 3, 4, 5].forEach(function(attempts) {
        const next = deliveryOutbox.nextAttemptDate({attempts, now, random: () => 0});
        const delay = next.getTime() - now.getTime();
        expect(delay).to.be.at.least(1000);
        expect(delay).to.be.at.most(30000);
        expect(delay).to.be.at.least(previous);
        previous = delay;
      });

      // attempts beyond the cap stay at the cap (deterministic mid-point jitter)
      const capped = deliveryOutbox.nextAttemptDate({attempts: 10, now, random: () => 0.5});
      expect(capped.getTime() - now.getTime()).to.equal(30000);
    });

    it('is exact with an injected deterministic jitter', function() {
      const now = new Date('2026-10-02T12:00:00Z');

      // Base backoff is BACKOFF_BASE_MS * 2^(attempts-1): 1000 * 2^0 = 1000.
      // Jitter is random() scaled to ±20% of the delay; random() = 0.5 keeps
      // the exact base.
      expect(
        deliveryOutbox.nextAttemptDate({attempts: 1, now, random: () => 0.5}).getTime()
      ).to.equal(now.getTime() + 1000);

      // 1000 * 2^3 = 8000 -> over the 30000 cap? no: 8000 < 30000.
      expect(
        deliveryOutbox.nextAttemptDate({attempts: 4, now, random: () => 0.5}).getTime()
      ).to.equal(now.getTime() + 8000);
    });
  });

  describe('claimDueRecords', function() {

    function buildModels({updateResult}) {
      const calls = {findAll: [], update: []};
      const models = {
        DeliveryOutbox : {
          findAll : function(args) {
            calls.findAll.push(args);
            return Promise.resolve([
              {id: 21, attempts: 0, status: 'pending', deliveryType: 'email'},
              {id: 22, attempts: 1, status: 'pending', deliveryType: 'edition_event'},
            ]);
          },
          update : function(values, args) {
            calls.update.push({values, args});
            return Promise.resolve(updateResult);
          },
        },
      };
      return {calls, models};
    }

    it('claims each due row with one conditional update keyed on the expected attempts', async function() {
      const {calls, models} = buildModels({updateResult: [1]});

      const claimed = await deliveryOutbox.claimDueRecords({
        models,
        now : new Date('2026-10-02T12:00:00Z'),
      });

      expect(calls.update.length).to.equal(2);
      expect(calls.update[0].args.where).to.deep.equal({id: 21, attempts: 0});
      expect(calls.update[1].args.where).to.deep.equal({id: 22, attempts: 1});

      // The claim already carries attempts+1 and the pre-scheduled retry time
      expect(calls.update[0].values.attempts).to.equal(1);
      expect(calls.update[0].values.nextAttemptAt).to.be.an.instanceOf(Date);

      expect(claimed.length).to.equal(2);
      expect(claimed[0].id).to.equal(21);
      expect(claimed[0].attempts).to.equal(1);
    });

    it('skips rows whose optimistic claim lost the race (0 affected rows)', async function() {
      const {models} = buildModels({updateResult: [0]});

      const claimed = await deliveryOutbox.claimDueRecords({
        models,
        now : new Date('2026-10-02T12:00:00Z'),
      });

      expect(claimed).to.deep.equal([]);
    });

    it('selects due pending rows ordered by id and excludes failed unless asked', async function() {
      const whereArgs = [];
      const models = {
        DeliveryOutbox : {
          findAll : function(args) {
            whereArgs.push(args.where);
            return Promise.resolve([]);
          },
          update : function() {
            return Promise.resolve([1]);
          },
        },
      };

      const now = new Date('2026-10-02T12:00:00Z');
      await deliveryOutbox.claimDueRecords({models, now});
      await deliveryOutbox.claimDueRecords({models, now, includeFailed: true});

      // plain pending-only sweep
      expect(whereArgs[0].status).to.equal('pending');
      expect(whereArgs[0].nextAttemptAt[Op.lte].getTime()).to.equal(now.getTime());

      // restart re-arm: failed records are also due again
      expect(whereArgs[1].status[Op.in]).to.deep.equal(['pending', 'failed']);
      expect(whereArgs[1].nextAttemptAt[Op.lte].getTime()).to.equal(now.getTime());
    });
  });

  describe('markDelivered / markFailed', function() {

    it('markDelivered fixes status delivered with delivered_at', async function() {
      const updates = [];
      const models = {
        DeliveryOutbox : {
          update : function(values, args) {
            updates.push({values, args});
            return Promise.resolve([1]);
          },
        },
      };

      const now = new Date('2026-10-02T12:05:00Z');
      await deliveryOutbox.markDelivered({models, id: 31, now});

      expect(updates.length).to.equal(1);
      expect(updates[0].values.status).to.equal('delivered');
      expect(updates[0].values.deliveredAt.getTime()).to.equal(now.getTime());
      expect(updates[0].args.where).to.deep.equal({id: 31});
    });

    it('markFailed fixes status failed and truncates last_error to 500 chars', async function() {
      const updates = [];
      const models = {
        DeliveryOutbox : {
          update : function(values, args) {
            updates.push({values, args});
            return Promise.resolve([1]);
          },
        },
      };

      const longMessage = 'x'.repeat(900);
      await deliveryOutbox.markFailed({models, id: 32, lastError: longMessage});

      expect(updates[0].values.status).to.equal('failed');
      expect(updates[0].values.lastError.length).to.equal(500);
      expect(updates[0].values.lastError).to.equal('x'.repeat(500));
      expect(updates[0].args.where).to.deep.equal({id: 32});
    });
  });

  describe('purgeDelivered', function() {

    it('deletes only delivered rows older than the horizon, in a bounded batch, by id list', async function() {
      const calls = {};
      const models = {
        DeliveryOutbox : {
          findAll : function(args) {
            calls.findAll = args;
            return Promise.resolve([{id: 41}, {id: 42}]);
          },
          destroy : function(args) {
            calls.destroy = args;
            return Promise.resolve(2);
          },
        },
      };

      const now = new Date('2026-10-02T12:00:00Z');
      const removed = await deliveryOutbox.purgeDelivered({
        models,
        now,
        limit : 500,
      });

      expect(calls.findAll.where.status).to.equal('delivered');
      expect(calls.findAll.limit).to.equal(500);
      // horizon = delivered_at < now - 7 days (default PURGE_AFTER_DELIVERED_MS)
      const expectedHorizon = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      expect(calls.findAll.where.deliveredAt[Op.lt].getTime()).to.equal(expectedHorizon.getTime());
      expect(calls.destroy.where.id).to.deep.equal([41, 42]);
      expect(removed).to.equal(2);
    });

    it('never selects pending or failed rows', async function() {
      const calls = {};
      const models = {
        DeliveryOutbox : {
          findAll : function(args) {
            calls.findAll = args;
            return Promise.resolve([]);
          },
          destroy : function(args) {
            calls.destroy = args;
            return Promise.resolve(0);
          },
        },
      };

      await deliveryOutbox.purgeDelivered({models, now: new Date()});

      // The selection predicate is delivered-only: no pending/failed status
      // ever appears in the where clause.
      expect(calls.findAll.where.status).to.equal('delivered');
      expect(calls.findAll.where.deliveredAt[Op.lt]).to.be.an.instanceOf(Date);
    });
  });
});
