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
      'after(function(done)'
    );

    expect(block).to.match(/return submit_form_func\(\{/);
    expect(block).to.match(/return check_booking_func\(\{/);
    expect(block).to.not.match(/\n\s*submit_form_func\(\{/);
    expect(block).to.not.match(/\n\s*check_booking_func\(\{/);
    expect(block).to.contain("submit_button_selector : '#book_leave_modal button[type=\"submit\"]'");
    expect(block).to.contain("modal_selector : '#book_leave_modal'");
    expect(block).to.contain('return check_no_booking');
  });
});
