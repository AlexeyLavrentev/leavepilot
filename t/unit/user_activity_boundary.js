'use strict';

/*
  end_date is the employee's last working day. Whether it has passed was asked
  in UTC, while the rest of the application asks the company - Company.get_today
  returns the company's own calendar date, and the users route already compares
  a submitted end_date against it correctly.

  For the offset between UTC and the company's timezone, every single day:

    - a company ahead of UTC carried a departed employee as active after their
      last day had ended. An hour for Europe/London in summer, three for
      Europe/Moscow, five or six for Asia/Almaty.
    - a company behind UTC struck an employee's name through, showed the
      "Deactivated" badge, and - in the edition that gates login on this -
      refused them a login, while their last day was still going.

  Measured on a running instance, company in America/New_York, employee whose
  last day is today: before, the badge was showing and the name was struck
  through at 01:40 UTC while it was 21:40 the previous day in the office.

  It also showed up as CI going red for an hour a day: an integration spec sets
  end_date to yesterday in Europe/London and looks for the badge, which is the
  right expectation and failed between 23:00 and midnight UTC through the whole
  of British Summer Time. The specs were right and the model was wrong.

  These fix the clock rather than the calendar - a test that asks what "today"
  is would drift back into the same ambiguity - so every case names both the
  company's date and the UTC date explicitly.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const dayjs = require('../../lib/util/date');
const Sequelize = require('sequelize');
const Op = Sequelize.Op;

// Its own database: other unit files close the shared one in an after hook.
const buildModels = async () => {
  const sequelize = new Sequelize('database', null, null, {
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });

  const modelsDir = path.join(__dirname, '..', '..', 'lib', 'model', 'db');

  fs.readdirSync(modelsDir)
    .filter(name => name.endsWith('.js') && name !== 'index.js')
    .forEach(name => {
      const define = require(path.join(modelsDir, name));

      if (typeof define === 'function') {
        define(sequelize, Sequelize.DataTypes);
      }
    });

  Object.values(sequelize.models).forEach(model => {
    if (typeof model.associate === 'function') {
      model.associate(sequelize.models);
    }
  });

  await sequelize.sync();

  return sequelize;
};

describe('Whether an employee is still with the company', function() {

  this.timeout(20000);

  let models;

  before(async function() {
    models = (await buildModels()).models;
  });

  // Built rather than saved: the question is what the model makes of the values,
  // and a round trip through sqlite would only add its own date handling to it.
  const employeeEnding = (endDate, timezone) => {
    const user = models.User.build({end_date: endDate});

    if (timezone) {
      user.company = models.Company.build({timezone});
    }

    return user;
  };

  /*
    The company's date is pinned rather than taken from the clock. Asking the
    real clock would only discriminate between the two formulas while UTC and
    the company happen to be on different dates - which is a few hours a day,
    and would make this file pass or fail by the hour exactly like the spec that
    started all of this.
  */
  const employeeEndingOn = (endDate, companyToday) => {
    const user = models.User.build({end_date: endDate});
    const company = models.Company.build({timezone: 'Etc/UTC'});

    company.get_today = () => dayjs.utc(companyToday);
    user.company = company;

    return user;
  };

  describe('with a company to ask', function() {

    /*
      2030 is years away from whatever today is when this runs, so the UTC
      formula answers "active" for every date here regardless of the clock. Any
      expectation of false below can only be met by asking the company.
    */
    const OFFICE_TODAY = '2030-06-17';

    it('keeps an employee whose last day is today, in the office, active', function() {
      expect(employeeEndingOn(OFFICE_TODAY, OFFICE_TODAY).is_active()).to.equal(
        true,
        'their last day is today in the office and they are already marked as gone'
      );
    });

    it('lets an employee go once that day has ended in the office', function() {
      expect(employeeEndingOn('2030-06-16', OFFICE_TODAY).is_active()).to.equal(
        false,
        'UTC would still call this active - the company was not asked'
      );
    });

    it('does not carry a departed employee long past their last day', function() {
      expect(employeeEndingOn('2029-01-01', OFFICE_TODAY).is_active()).to.equal(false);
    });

    it('keeps an employee whose last day is still ahead', function() {
      expect(employeeEndingOn('2030-06-18', OFFICE_TODAY).is_active()).to.equal(true);
    });

    it('leaves an employee with no end date alone', function() {
      expect(employeeEndingOn(null, OFFICE_TODAY).is_active()).to.equal(true);
    });
  });

  /*
    The same contract stated against a real company in a real timezone, which is
    what the running application does. These hold at any hour because the dates
    are relative to the company's own today rather than to UTC.
  */
  describe('against a company in its own timezone', function() {

    ['America/New_York', 'Europe/Moscow', 'Asia/Almaty', 'Europe/London'].forEach(timezone => {

      it('is right in ' + timezone + ' at whatever time this runs', function() {
        const company = models.Company.build({timezone});
        const officeToday = company.get_today();

        const on = date => {
          const user = models.User.build({end_date: date.format('YYYY-MM-DD')});
          user.company = company;
          return user.is_active();
        };

        expect(on(officeToday.clone()), 'last day is today').to.equal(true);
        expect(on(officeToday.clone().add(1, 'day')), 'last day is tomorrow').to.equal(true);
        expect(on(officeToday.clone().subtract(1, 'day')), 'last day was yesterday').to.equal(false);
      });
    });
  });

  describe('the boundary can be handed in', function() {

    // The users list holds the company but its query does not put it on the
    // rows, so it passes the date instead of relying on the association.
    it('uses the date it was given', function() {
      const user = models.User.build({end_date: '2026-08-05'});

      expect(user.is_active(dayjs.utc('2026-08-05'))).to.equal(true, 'their last day');
      expect(user.is_active(dayjs.utc('2026-08-06'))).to.equal(false, 'the day after');
      expect(user.is_active(dayjs.utc('2026-08-04'))).to.equal(true, 'the day before');
    });

    it('prefers what it was given over the company it carries', function() {
      const user = employeeEnding('2026-08-05', 'Europe/Moscow');

      expect(user.is_active(dayjs.utc('2026-08-09'))).to.equal(false);
    });
  });

  /*
    Called from a template, which cannot pass an argument, and synchronous, so
    it cannot fetch one. UTC is what is left when there is no company - stated
    here so that it is a decision rather than something a reader has to infer,
    and so that a caller relying on it is visible.
  */
  describe('with no company loaded', function() {

    it('falls back to UTC', function() {
      const utcToday = dayjs.utc().format('YYYY-MM-DD');
      const utcYesterday = dayjs.utc().subtract(1, 'day').format('YYYY-MM-DD');

      expect(employeeEnding(utcToday).is_active()).to.equal(true);
      expect(employeeEnding(utcYesterday).is_active()).to.equal(false);
    });
  });

  /*
    The same question asked in SQL. It used to be the only version, and it is
    what the team view reads: an employee whose last day had ended in the office
    was still on it, which is what a second integration spec asserts and what
    hung it for an hour a day.
  */
  describe('the same question asked in SQL', function() {

    const parts = filter => filter[Op.or];
    const upperBound = filter => parts(filter)
      .map(part => part.end_date[Op.gte])
      .find(value => value !== undefined);

    it('bounds on the date it was given', function() {
      expect(upperBound(models.User.get_active_user_filter(dayjs.utc('2030-06-17'))))
        .to.equal('2030-06-17');
    });

    it('still lets through an employee with no end date', function() {
      const withoutEndDate = parts(models.User.get_active_user_filter(dayjs.utc('2030-06-17')))
        .some(part => part.end_date[Op.eq] === null);

      expect(withoutEndDate).to.equal(true);
    });

    it('falls back to UTC for the callers that cannot know the company', function() {
      expect(upperBound(models.User.get_active_user_filter()))
        .to.equal(dayjs.utc().startOf('day').format('YYYY-MM-DD'));
    });
  });

  describe('the paths that render it', function() {

    const source = file => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

    it('passes the boundary from the users list, which holds the company', function() {
      expect(source('lib/route/users/index.js'))
        .to.match(/is_active\s*:\s*ui\.user_row\.is_active\(company\.get_today\(\)\)/);
    });

    /*
      The employee comes back nested inside the company, which does not give it
      the other half of the association, and the three pages rendered from that
      loader ask the question from a template.
    */
    it('attaches the company to the employee the details pages render', function() {
      expect(source('lib/model/mixin/user/company_aware.js'))
        .to.match(/company\.users\.forEach\(user => \{ user\.company = company; \}\)/);
    });

    // It loads the company already - the team view cache is keyed on its today
    // - so the filter is asked in the same clock as the key.
    it('asks the team view filter in the company clock', function() {
      expect(source('lib/model/db/department.js'))
        .to.match(/promise_active_users\(company\.get_today\(\)\)/);
      expect(source('lib/model/db/department.js'))
        .to.match(/get_active_user_filter\(today\)/);
    });

    it('asks it in the same clock when picking who to remind', function() {
      expect(source('lib/model/leave/reminder_scheduler.js'))
        .to.match(/get_active_user_filter\(company\.get_today\(\)\)/);
    });
  });

});
