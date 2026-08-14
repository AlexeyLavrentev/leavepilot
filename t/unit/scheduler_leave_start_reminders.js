'use strict';

var expect = require('chai').expect;

var scheduler = require('../../lib/scheduler/leave_start_reminders');

describe('Leave start reminder scheduler', function() {
  var originalEnv = {};

  beforeEach(function() {
    // Both feature-switch generations are snapshotted: the CI coverage
    // contour exports the canonical LEAVEPILOT_* names, and envResolver
    // lets the canonical generation win over the legacy one this scaffold
    // used to clear alone.
    originalEnv = {
      NODE_ENV : process.env.NODE_ENV,
      LEAVE_REMINDER_SCHEDULER_ENABLED : process.env.LEAVE_REMINDER_SCHEDULER_ENABLED,
      TIMEOFF_FEATURES : process.env.TIMEOFF_FEATURES,
      LEAVEPILOT_FEATURES : process.env.LEAVEPILOT_FEATURES,
      TIMEOFF_LICENSE : process.env.TIMEOFF_LICENSE,
      LEAVEPILOT_LICENSE : process.env.LEAVEPILOT_LICENSE,
      TIMEOFF_LICENSE_SECRET : process.env.TIMEOFF_LICENSE_SECRET,
      LEAVEPILOT_LICENSE_SECRET : process.env.LEAVEPILOT_LICENSE_SECRET,
      ALLOW_UNLICENSED_FEATURE_OVERRIDES : process.env.ALLOW_UNLICENSED_FEATURE_OVERRIDES,
      FEATURE_LEAVE_START_REMINDERS : process.env.FEATURE_LEAVE_START_REMINDERS,
    };
  });

  afterEach(function() {
    Object.keys(originalEnv).forEach(function(key) {
      if (typeof originalEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });

  it('is disabled without the scheduler env flag', function() {
    delete process.env.LEAVE_REMINDER_SCHEDULER_ENABLED;

    expect(scheduler.isSchedulerEnabled()).to.equal(false);
  });

  it('is enabled by default with the scheduler env flag (community feature)', function() {
    process.env.NODE_ENV = 'production';
    process.env.LEAVE_REMINDER_SCHEDULER_ENABLED = 'true';
    delete process.env.TIMEOFF_FEATURES;
    delete process.env.LEAVEPILOT_FEATURES;
    delete process.env.TIMEOFF_LICENSE;
    delete process.env.LEAVEPILOT_LICENSE;
    delete process.env.TIMEOFF_LICENSE_SECRET;
    delete process.env.LEAVEPILOT_LICENSE_SECRET;
    delete process.env.ALLOW_UNLICENSED_FEATURE_OVERRIDES;

    expect(scheduler.isSchedulerEnabled()).to.equal(true);
  });

  it('respects an explicit feature kill switch', function() {
    process.env.NODE_ENV = 'production';
    process.env.LEAVE_REMINDER_SCHEDULER_ENABLED = 'true';
    process.env.FEATURE_LEAVE_START_REMINDERS = 'false';

    expect(scheduler.isSchedulerEnabled()).to.equal(false);
  });

  it('calculates next run today when schedule time is still ahead', function() {
    var nextRunAt = scheduler.getNextRunAt({
      now          : new Date('2026-05-08T08:30:00Z'),
      scheduleTime : '09:00',
      timezone     : 'UTC',
    });

    expect(nextRunAt.toISOString()).to.equal('2026-05-08T09:00:00.000Z');
  });

  it('calculates next run tomorrow when schedule time already passed', function() {
    var nextRunAt = scheduler.getNextRunAt({
      now          : new Date('2026-05-08T09:30:00Z'),
      scheduleTime : '09:00',
      timezone     : 'UTC',
    });

    expect(nextRunAt.toISOString()).to.equal('2026-05-09T09:00:00.000Z');
  });

  it('skips job when DB task lock is already held', async function() {
    var findOneCalls = 0;
    var emailCalls = 0;

    var models = {
      ScheduledTaskLock : {
        findOne : function() {
          findOneCalls += 1;
          return Promise.resolve({
            locked_until : new Date('2099-01-01T00:00:00Z'),
          });
        },
      },
    };

    var result = await scheduler.runLeaveReminderJob({
      models,
      emailTransport : {
        promise_upcoming_leave_start_reminder_email : function() {
          emailCalls += 1;
          return Promise.resolve();
        },
      },
      logger : {
        log   : function() {},
        error : function() {},
      },
    });

    expect(findOneCalls).to.equal(1);
    expect(emailCalls).to.equal(0);
    expect(result.skipped).to.equal(true);
  });
});
