'use strict';

var fs = require('fs'),
    expect = require('chai').expect;

var source = fs.readFileSync('t/integration/leave_type/leave_type_limit_next_year.js', 'utf8');

function booking_block(start, end) {
  var from = source.indexOf(start);
  var to = source.indexOf(end, from);

  expect(from, 'booking block start').to.be.at.least(0);
  expect(to, 'booking block end').to.be.at.least(from);

  return source.slice(from, to);
}

describe('next-year leave-limit submit contract', function(){
  for (const currentYear of [2026, 2030, 2036]) {
    it(`books two working days in the next year when run in ${currentYear}`, async function(){
      const vm = require('node:vm');
      const {createRequire} = require('node:module');
      const filename = require('node:path').resolve('t/integration/leave_type/leave_type_limit_next_year.js');
      const localRequire = createRequire(filename);
      const dayjs = localRequire('../../../lib/util/date');
      const tests = new Map();
      const bookings = [];
      const driver = {
        then: callback => Promise.resolve().then(callback),
        findElement: () => Promise.resolve({click: async () => {}, getAttribute: async () => ''}),
        wait: async () => {},
      };
      vm.runInNewContext(source, {
        require: name => {
          if (name === '../../../lib/util/date') {
            return {utc: value => dayjs.utc(value === undefined ? `${currentYear}-09-08` : value)};
          }
          if (name === '../../lib/config') {
            return {get_application_host: () => 'http://example.test/', get_execution_timeout: () => 1000};
          }
          if (name === '../../lib/submit_form') {
            return async options => { bookings.push(options.form_params.map(param => param.value)); };
          }
          if (name.startsWith('../../lib/')) { return async () => ({driver}); }
          return localRequire(name);
        },
        describe: (_title, callback) => callback.call({timeout() {}}),
        it: (title, callback) => tests.set(title, callback),
        after() {},
      }, {filename});
      for (const title of ['Create new company', 'Add a request that fits under the limit',
        'And try to request one more day of the type already 100% taken']) {
        await new Promise((resolve, reject) => tests.get(title)(error => error ? reject(error) : resolve()));
      }
      expect(bookings).to.have.length(2);
      for (const [from, to] of bookings) {
        expect(from).to.equal(to);
        expect(dayjs.utc(from).year()).to.equal(currentYear + 1);
        expect(dayjs.utc(from).day(), from).to.be.within(1, 5);
      }
      expect(dayjs.utc(bookings[0][0]).date()).to.be.within(8, 14);
      expect(dayjs.utc(bookings[1][0]).diff(dayjs.utc(bookings[0][0]), 'days')).to.equal(7);
    });
  }

  it('returns both successful booking operations through Mocha', function(){
    var block = booking_block(
      'it("Add a request that fits under the limit"',
      'it("Logout from regular user session"'
    );

    expect(block).to.match(/return submit_form_func\(\{/);
    expect(block).to.match(/return check_booking_func\(\{/);
    expect(block).to.not.match(/\n\s*submit_form_func\(\{/);
    expect(block).to.not.match(/\n\s*check_booking_func\(\{/);
    expect(block).to.contain("submit_button_selector : '#book_leave_modal button[type=\"submit\"]'");
    expect(block).to.contain("modal_selector : '#book_leave_modal'");
  });

  it('returns both rejected booking operations through Mocha', function(){
    var block = booking_block(
      'it("And try to request one more day of the type already 100% taken"',
      'after(async function('
    );

    expect(block).to.match(/return submit_form_func\(\{/);
    expect(block).to.match(/return check_booking_func\(\{/);
    expect(block).to.not.match(/\n\s*submit_form_func\(\{/);
    expect(block).to.not.match(/\n\s*check_booking_func\(\{/);
    expect(block).to.contain("submit_button_selector : '#book_leave_modal button[type=\"submit\"]'");
    expect(block).to.contain("modal_selector : '#book_leave_modal'");
    expect(block).to.contain("return check_booking_func({driver, full_days: [second_leave_day], type: 'absent'});");
  });

  it('waits for the approved pending request to leave the page before logging out', function(){
    var block = booking_block(
      'it("Approve newly added leave request"',
      'it("Logout from admin account"'
    );

    expect(block).to.contain('const pendingRequestSelector');
    expect(block).to.contain('let pendingRequestRow');
    expect(block).to.contain('return row.findElement(By.css(\'.btn-success\'))');
    expect(block).to.contain('return driver.findElements(By.css(pendingRequestSelector));');
    expect(block).to.contain("error.name === 'StaleElementReferenceError'");
    expect(block).to.contain('}, 1000);');
  });
});
