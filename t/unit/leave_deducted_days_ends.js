'use strict';

/*
  get_deducted_days_number counts the days get_deducted_days returns - the
  filtered list, with bank holidays, weekends and days from another year taken
  out - and then took its half-day corrections from somewhere else:

    if (number_of_days === 1 && !this.get_start_leave_day().is_all_day_leave())

  get_start_leave_day() is get_days()[0] and get_end_leave_day() is the last of
  the same, both from the *unfiltered* list. So a half day that the filter had
  already removed still took its half off the total.

  The clearest case is a leave across the new year. 31 December afternoon
  through 6 January, asked for 2026:

    filtered days   1, 2, 5, 6 January        -> 4
    correction      31 December is a half day -> 3.5

  and 31 December is not in that list. The same thing happens at the end, and
  it does not need a year boundary: a leave starting on a Saturday afternoon
  loses half a day the same way, because the Saturday is filtered out as a
  non-working day.

  Always in the employee's favour, and not only on screen -
  calculate_number_of_days_taken_from_allowance and the over-allowance check
  both read this number, so the figure the allowance is kept in is the wrong
  one.

  Built in memory, as the deduction-unit block in t/unit/model/db/leave.js is:
  no database, and the schedule and holidays are stated outright so the
  arithmetic is readable.
*/

const expect = require('chai').expect;
const model = require('../../lib/model/db');

describe('Deducted days at the ends of a leave', function() {

  const weekdaysOnly = {
    is_it_working_day : args => args.day.isoWeekday() < 6,
  };

  const buildUser = bankHolidays => {
    const user = model.User.build({
      name: 'Ends', lastname: 'Employee', email: 'ends@example.test', password: 'password',
    });

    user.cached_schedule = weekdaysOnly;
    user.company = { bank_holidays : bankHolidays || [] };

    return user;
  };

  const holiday = date => model.BankHoliday.build({name: 'Holiday', date});

  const workingDays = model.LeaveType.build({
    name: 'Holiday', use_allowance: true, deduction_unit: 'working_days',
  });

  const leaveOf = (start, end, parts) => model.Leave.build({
    status         : model.Leave.status_approved(),
    date_start     : start,
    date_end       : end,
    day_part_start : (parts && parts.start) || model.Leave.leave_day_part_all(),
    day_part_end   : (parts && parts.end) || model.Leave.leave_day_part_all(),
  });

  const deducted = (leave, args) => leave.get_deducted_days_number(Object.assign({
    user       : buildUser(),
    leave_type : workingDays,
  }, args || {}));

  describe('across a year boundary', function() {

    /*
      Wed 31 December 2025 from the afternoon, through Tue 6 January 2026.
      2026 keeps Thu 1, Fri 2, Mon 5, Tue 6 - the weekend of 3 and 4 drops out.
    */
    const newYearLeave = () => leaveOf('2025-12-31', '2026-01-06', {
      start: model.Leave.leave_day_part_afternoon(),
    });

    it('does not take the other year\'s half day off this year', function() {
      expect(deducted(newYearLeave(), {year: '2026'})).to.equal(
        4,
        'the half of 31 December was subtracted from a list it is not in'
      );
    });

    it('still charges that half day to the year it falls in', function() {
      expect(deducted(newYearLeave(), {year: '2025'})).to.equal(0.5);
    });

    // The point of the two above: the leave is worth 4.5 days and has to stay
    // worth 4.5 however it is split between the two years.
    it('adds up to the same total across both years', function() {
      const leave = newYearLeave();

      expect(deducted(leave, {year: '2025'}) + deducted(leave, {year: '2026'}))
        .to.equal(deducted(newYearLeave()));
    });

    /*
      The end of the leave, which is the same mistake read from the other side:
      Mon 29 December 2025 through Fri 2 January 2026, ending at midday.
    */
    it('does not take a half day off the year the leave ends outside of', function() {
      const leave = leaveOf('2025-12-29', '2026-01-02', {
        end: model.Leave.leave_day_part_morning(),
      });

      expect(deducted(leave, {year: '2025'})).to.equal(3);
      expect(deducted(leave, {year: '2026'})).to.equal(1.5);
    });
  });

  describe('when the filter drops an end for another reason', function() {

    /*
      No year boundary needed. Sat 3 January 2026 from the afternoon through
      Wed 7 January: the Saturday and Sunday are not working days, so the leave
      is worth the three weekdays and nothing else.
    */
    it('ignores a half day that fell on a weekend', function() {
      const leave = leaveOf('2026-01-03', '2026-01-07', {
        start: model.Leave.leave_day_part_afternoon(),
      });

      expect(deducted(leave)).to.equal(
        3,
        'half a Saturday was deducted from a working-days leave'
      );
    });

    it('ignores a half day that fell on a bank holiday', function() {
      const leave = leaveOf('2026-01-05', '2026-01-07', {
        end: model.Leave.leave_day_part_morning(),
      });

      expect(leave.get_deducted_days_number({
        user       : buildUser([holiday('2026-01-07')]),
        leave_type : workingDays,
      })).to.equal(2);
    });
  });

  describe('what it has to keep getting right', function() {

    it('counts a whole working week', function() {
      expect(deducted(leaveOf('2026-01-05', '2026-01-09'))).to.equal(5);
    });

    it('counts a single half day as half', function() {
      expect(deducted(leaveOf('2026-01-05', '2026-01-05', {
        start: model.Leave.leave_day_part_afternoon(),
        end  : model.Leave.leave_day_part_afternoon(),
      }))).to.equal(0.5);
    });

    it('counts a single whole day as one', function() {
      expect(deducted(leaveOf('2026-01-05', '2026-01-05'))).to.equal(1);
    });

    it('takes half off a start that survives the filter', function() {
      expect(deducted(leaveOf('2026-01-05', '2026-01-07', {
        start: model.Leave.leave_day_part_afternoon(),
      }))).to.equal(2.5);
    });

    it('takes half off an end that survives the filter', function() {
      expect(deducted(leaveOf('2026-01-05', '2026-01-07', {
        end: model.Leave.leave_day_part_morning(),
      }))).to.equal(2.5);
    });

    it('takes half off both when both survive', function() {
      expect(deducted(leaveOf('2026-01-05', '2026-01-07', {
        start: model.Leave.leave_day_part_afternoon(),
        end  : model.Leave.leave_day_part_morning(),
      }))).to.equal(2);
    });

    // Nothing left after filtering is nothing deducted, not a negative half.
    it('deducts nothing when the filter leaves no days at all', function() {
      const leave = leaveOf('2026-01-03', '2026-01-04', {
        start: model.Leave.leave_day_part_afternoon(),
      });

      expect(deducted(leave)).to.equal(0);
    });
  });
});
