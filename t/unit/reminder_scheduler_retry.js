'use strict';

const expect = require('chai').expect;
const moment = require('moment');
const scheduler = require('../../lib/model/leave/reminder_scheduler');

describe('Configurable reminder delivery retries', function() {
  it('releases a notification reservation after a failed email', async function() {
    /*
      In production this comes from Company.findAll, and the scheduler asks it
      what day it is so that it does not remind an employee who left yesterday
      in the office but not yet in UTC. The stand-in has to answer that too.
    */
    const company = {id: 55, get_today: () => moment.utc('2026-06-05')};
    const employee = {
      id: 10,
      email: 'employee@example.com',
      companyId: company.id,
      department: {id: 8, boss: null},
    };
    const leave = {
      id: 7,
      leave_type_id: 3,
      date_start: '2026-06-12',
      user: employee,
    };
    const schedule = {
      id: 4,
      days_before: 7,
      leave_type_id: null,
      recipient_supervisor: false,
      recipient_employee: true,
    };

    let destroyCalls = 0;
    let emailCalls = 0;
    const models = {
      ReminderSchedule: {findAll: async function() { return [schedule]; }},
      Leave: {
        status_approved: function() { return 2; },
        status_pended_revoke: function() { return 4; },
        findAll: async function() { return [leave]; },
      },
      User: {get_active_user_filter: function() { return {}; }},
      LeaveNotification: {
        findOrCreate: async function() {
          return [{destroy: async function() { destroyCalls += 1; }}, true];
        },
      },
    };
    const emailTransport = {
      promise_upcoming_leave_start_reminder_email: async function() {
        emailCalls += 1;
        if (emailCalls === 1) throw new Error('temporary SMTP failure');
      },
    };

    const originalError = console.error;
    console.error = function() {};
    try {
      const first = await scheduler.sendRemindersForCompany({
        company, models, emailTransport, date: '2026-06-05',
      });
      const second = await scheduler.sendRemindersForCompany({
        company, models, emailTransport, date: '2026-06-05',
      });

      expect(first).to.have.length(0);
      expect(second).to.have.length(1);
      expect(emailCalls).to.equal(2);
      expect(destroyCalls).to.equal(1);
    } finally {
      console.error = originalError;
    }
  });
});
