"use strict";


const dayjs = require('../util/date');
const dayjs = require('../util/date');

const Email = require('../email');
const features = require('../features');
const reminderScheduler = require('../model/leave/reminder_scheduler');
const taskLock = require('./task_lock');

const TASK_NAME = 'leave_start_reminders';
const DEFAULT_SCHEDULE_TIME = '09:00';
const DEFAULT_SCHEDULE_TIMEZONE = 'UTC';
const DEFAULT_LOCK_TTL_MINUTES = 60;

const isSchedulerEnabled = () => (
  String(process.env.LEAVE_REMINDER_SCHEDULER_ENABLED || '').toLowerCase() === 'true'
  && features.isEnabled('leave_start_reminders')
);

const parseScheduleTime = timeString => {
  const value = String(timeString || DEFAULT_SCHEDULE_TIME).trim();
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);

  if (!match) {
    throw new Error('LEAVE_REMINDER_SCHEDULER_TIME must be in HH:mm format');
  }

  return {
    hours   : Number(match[1]),
    minutes : Number(match[2]),
  };
};

const getNextRunAt = ({
  now,
  scheduleTime,
  timezone,
}) => {
  const effectiveTimezone = timezone || process.env.LEAVE_REMINDER_SCHEDULER_TIMEZONE || process.env.TZ || DEFAULT_SCHEDULE_TIMEZONE;
  const current = dayjs.tz(now || new Date(), effectiveTimezone);
  const parsedTime = parseScheduleTime(scheduleTime);
  const nextRunAt = current.clone()
    .hour(parsedTime.hours)
    .minute(parsedTime.minutes)
    .second(0)
    .millisecond(0);

  if (!nextRunAt.isAfter(current)) {
    nextRunAt.add(1, 'day');
  }

  return nextRunAt.toDate();
};

const getDelayUntil = nextRunAt => Math.max(1000, dayjs(nextRunAt).diff(dayjs()));

const runLeaveReminderJob = async ({
  models,
  emailTransport,
  logger,
  lockTtlMinutes,
}) => {
  const effectiveLogger = logger || console;
  const lockResult = await taskLock.tryAcquireTaskLock({
    models,
    taskName    : TASK_NAME,
    ttlMinutes  : lockTtlMinutes || DEFAULT_LOCK_TTL_MINUTES,
  });

  if (!lockResult.acquired) {
    effectiveLogger.log('Leave reminder scheduler skipped: task lock is held by another process');
    return {
      skipped : true,
      sent    : 0,
    };
  }

  try {
    const notifications = await reminderScheduler.sendLeaveStartReminders({
      models,
      emailTransport : emailTransport || new Email(),
    });

    effectiveLogger.log('Leave reminder scheduler sent notifications: ' + notifications.length);

    return {
      skipped : false,
      sent    : notifications.length,
    };
  } finally {
    await taskLock.releaseTaskLock({
      lock     : lockResult.lock,
      lockedBy : lockResult.lockedBy,
    });
  }
};

const startLeaveReminderScheduler = ({
  models,
  emailTransport,
  logger,
  scheduleTime,
  timezone,
  lockTtlMinutes,
}) => {
  const effectiveLogger = logger || console;

  if (!isSchedulerEnabled()) {
    effectiveLogger.log('Leave reminder scheduler disabled');
    return {
      stop : function() {},
    };
  }

  const effectiveScheduleTime = scheduleTime || process.env.LEAVE_REMINDER_SCHEDULER_TIME || DEFAULT_SCHEDULE_TIME;
  const effectiveTimezone = timezone || process.env.LEAVE_REMINDER_SCHEDULER_TIMEZONE || process.env.TZ || DEFAULT_SCHEDULE_TIMEZONE;
  let timeoutId = null;
  let isStopped = false;

  const scheduleNextRun = () => {
    if (isStopped) {
      return;
    }

    const nextRunAt = getNextRunAt({
      scheduleTime : effectiveScheduleTime,
      timezone     : effectiveTimezone,
    });
    const delay = getDelayUntil(nextRunAt);

    effectiveLogger.log(
      'Leave reminder scheduler next run at '
      + dayjs(nextRunAt).tz(effectiveTimezone).format()
      + ' (' + effectiveTimezone + ')'
    );

    timeoutId = setTimeout(async function() {
      try {
        await runLeaveReminderJob({
          models,
          emailTransport,
          logger         : effectiveLogger,
          lockTtlMinutes : lockTtlMinutes || DEFAULT_LOCK_TTL_MINUTES,
        });
      } catch (error) {
        effectiveLogger.error(
          'Leave reminder scheduler failed: '
          + (error && error.stack || error)
        );
      } finally {
        scheduleNextRun();
      }
    }, delay);

    if (timeoutId && typeof timeoutId.unref === 'function') {
      timeoutId.unref();
    }
  };

  scheduleNextRun();

  return {
    stop : function() {
      isStopped = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  };
};

const runLeaveRemindersOnce = async ({
  models,
  date,
  companyId,
}) => reminderScheduler.sendLeaveStartReminders({
  models,
  emailTransport : new Email(),
  date,
  companyId,
});

module.exports = {
  DEFAULT_LOCK_TTL_MINUTES,
  DEFAULT_SCHEDULE_TIME,
  DEFAULT_SCHEDULE_TIMEZONE,
  TASK_NAME,
  getNextRunAt,
  isSchedulerEnabled,
  parseScheduleTime,
  runLeaveReminderJob,
  runLeaveRemindersOnce,
  startLeaveReminderScheduler,
};
