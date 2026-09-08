
'use strict';

var expect  = require('chai').expect,
    _       = require('underscore'),
    model   = require('../../lib/model/db'),
    dayjs = require('../../lib/util/date'),
    schedule= model.Schedule.build({ company_id : 1 }),
    CalendarMonth = require('../../lib/model/calendar_month');


describe('Check calendar month object', function(){

    it('Normalize provided date to be at the begining of the month',function(){
        var january = new CalendarMonth('2015-01-10', {schedule : schedule, today : dayjs.utc()});

        expect(
            january.get_base_date().date()
        ).to.be.equal(1);
    });

    it('Knows on which week day month starts', function(){
        var january = new CalendarMonth('2015-01-21', {schedule : schedule, today : dayjs.utc()});
        expect( january.week_day() ).to.be.equal(4);

        var feb = new CalendarMonth('2015-02-21', {schedule : schedule, today : dayjs.utc()});
        expect( feb.week_day() ).to.be.equal(7);
    });

    it('Knows how many blanks to put before first day of the month', function(){
        var january = new CalendarMonth('2015-01-11', {schedule : schedule, today : dayjs.utc()});
        expect( january.how_many_blanks_at_the_start() ).to.be.equal(3);

        var feb = new CalendarMonth('2015-02-11', {schedule : schedule, today : dayjs.utc()});
        expect( feb.how_many_blanks_at_the_start() ).to.be.equal(6);
    });

    it('Knows how many blanks to put after the last day of the month', function(){
        var january = new CalendarMonth('2015-01-11', {schedule : schedule, today : dayjs.utc()});
        expect( january.how_many_blanks_at_the_end() ).to.be.equal(1);

        var feb = new CalendarMonth('2015-02-11', {schedule : schedule, today : dayjs.utc()});
        expect( feb.how_many_blanks_at_the_end() ).to.be.equal(1);
    });

    it('Knows whether day is weekend', function(){
        var feb = new CalendarMonth('2015-02-12', {schedule : schedule, today : dayjs.utc()});
        expect(feb.is_weekend(12)).not.to.be.ok;
        expect(feb.is_weekend(21)).to.be.ok;
        expect(feb.is_weekend(22)).to.be.ok;
        expect(feb.is_weekend(23)).not.to.be.ok;
    });

    it('Knows whether day is calendar weekend regardless of work schedule', function(){
        var all_days_schedule = model.Schedule.build({
              company_id : 1,
              saturday   : true,
              sunday     : true,
            }),
            feb = new CalendarMonth('2015-02-12', {schedule : all_days_schedule, today : dayjs.utc()});

        expect(feb.is_weekend(21)).not.to.be.ok;
        expect(feb.is_weekend(22)).not.to.be.ok;
        expect(feb.is_calendar_weekend(21)).to.be.ok;
        expect(feb.is_calendar_weekend(22)).to.be.ok;
        expect(feb.is_calendar_weekend(23)).not.to.be.ok;
    });

    it('Knows how to generate data structure for template', function(){
        var january = new CalendarMonth('2015-01-11', { schedule : schedule, today : dayjs.utc() }),
          object_to_test = january.as_for_template();
        expect(object_to_test.weeks[0][3].dayjs.format('YYYY-MM-DD')).to.equal('2015-01-01');
        expect(object_to_test.weeks[4][5].dayjs.format('YYYY-MM-DD')).to.equal('2015-01-31');
        delete object_to_test.dayjs;
        object_to_test.weeks.forEach(function(week){
          week.forEach(function(day){
            delete day.dayjs;
            delete day.leave_obj;
          });
        });
        expect( object_to_test ).to.be.eql(
            {"month":"January","weeks":[[{"val":""},{"val":""},{"val":""},{"val":1},{"val":2},{"val":3,"is_calendar_weekend":true,"is_weekend":true},{"val":4,"is_calendar_weekend":true,"is_weekend":true}],[{"val":5},{"val":6},{"val":7},{"val":8},{"val":9},{"val":10,"is_calendar_weekend":true,"is_weekend":true},{"val":11,"is_calendar_weekend":true,"is_weekend":true}],[{"val":12},{"val":13},{"val":14},{"val":15},{"val":16},{"val":17,"is_calendar_weekend":true,"is_weekend":true},{"val":18,"is_calendar_weekend":true,"is_weekend":true}],[{"val":19},{"val":20},{"val":21},{"val":22},{"val":23},{"val":24,"is_calendar_weekend":true,"is_weekend":true},{"val":25,"is_calendar_weekend":true,"is_weekend":true}],[{"val":26},{"val":27},{"val":28},{"val":29},{"val":30},{"val":31,"is_calendar_weekend":true,"is_weekend":true},{"val":""}]]}
        );


        var apr = new CalendarMonth('2015-04-11', { schedule : schedule, today : dayjs.utc() });
        object_to_test = apr.as_for_template();
        delete object_to_test.dayjs;
        object_to_test.weeks.forEach(function(week){
          week.forEach(function(day){
            delete day.dayjs;
            delete day.leave_obj;
          });
        });
        expect( object_to_test ).to.be.eql(
            {"month":"April","weeks":[[{"val":""},{"val":""},{"val":1},{"val":2},{"val":3},{"val":4,"is_calendar_weekend":true,"is_weekend":true},{"val":5,"is_calendar_weekend":true,"is_weekend":true}],[{"val":6},{"val":7},{"val":8},{"val":9},{"val":10},{"val":11,"is_calendar_weekend":true,"is_weekend":true},{"val":12,"is_calendar_weekend":true,"is_weekend":true}],[{"val":13},{"val":14},{"val":15},{"val":16},{"val":17},{"val":18,"is_calendar_weekend":true,"is_weekend":true},{"val":19,"is_calendar_weekend":true,"is_weekend":true}],[{"val":20},{"val":21},{"val":22},{"val":23},{"val":24},{"val":25,"is_calendar_weekend":true,"is_weekend":true},{"val":26,"is_calendar_weekend":true,"is_weekend":true}],[{"val":27},{"val":28},{"val":29},{"val":30},{"val":""},{"val":""},{"val":""}]]}
        );

    });


    it('Sanity checks pass', function(){

        var apr = new CalendarMonth('2015-04-01', { schedule : schedule, today : dayjs.utc() });

        expect(apr).to.be.a('object');

        expect(apr.how_many_days()).to.be.equal(30);
    });

    it('It knows whether day is bank holiday', function(){
        var mar = new CalendarMonth('2015-03-19', { bank_holidays : [{date : '2015-03-08'}], schedule : schedule, today : dayjs.utc() });

        expect(mar.is_bank_holiday(8)).to.be.ok;
        expect(mar.is_bank_holiday(10)).not.to.be.ok;
    });

    it('Treats an explicitly working weekend as a working day', function(){
        var may = new CalendarMonth('2026-05-01', {
            working_day_overrides : [{date : '2026-05-02'}],
            schedule : schedule,
            today : dayjs.utc()
        });

        expect(may.is_weekend(2)).not.to.be.ok;
        expect(may.is_weekend(3)).to.be.ok;
    });

});

describe('Full-year calendar month selection', function(){
  for (const timezone of ['UTC', 'Asia/Yekaterinburg', 'America/Los_Angeles']) {
    it('selects January through December of the requested year in ' + timezone, function(){
      const result = require('node:child_process').spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const dayjs = require('./lib/util/date');
        const user = {};
        require('./lib/model/mixin/user/absence_aware').call(user, {});
        for (const yearNumber of [2018, 2024, 2026]) {
          const year = dayjs.utc(yearNumber + '-12-31T12:34:56Z');
          const original = year.toISOString();
          const months = user._get_calendar_months_to_show({year, show_full_year: true});
          assert.deepEqual(months.map(month => month.format('YYYY-MM-DD')),
            Array.from({length: 12}, (_, i) => yearNumber + '-' + String(i + 1).padStart(2, '0') + '-01'));
          assert.ok(months.every(month => month.isUTC() && month.hour() === 0));
          assert.equal(year.toISOString(), original);
        }
      `], {encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', env: {...process.env, TZ: timezone}});
      expect(result.error).to.equal(undefined);
      expect(result.status, result.stderr).to.equal(0);
    });
  }

  it('preserves the rolling four-month view across New Year', function(){
    const today = dayjs.utc('2026-11-20');
    const user = {company: {get_today: () => today.clone()}};
    const months = model.User.prototype._get_calendar_months_to_show.call(user, {
      year: dayjs.utc('2018-01-01'), show_full_year: false,
    });
    expect(months.map(month => month.format('YYYY-MM-DD'))).to.deep.equal([
      '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01',
    ]);
    expect(today.format('YYYY-MM-DD')).to.equal('2026-11-20');
  });
});
