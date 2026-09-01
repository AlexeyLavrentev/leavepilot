'use strict';

var fs = require('fs'),
    expect = require('chai').expect;

var source = fs.readFileSync('t/integration/leave_request/try_to_overbook_allowance.js', 'utf8');

describe('overbook allowance submit contract', function(){
  it('returns the rejected booking submit and scopes it to the leave modal', function(){
    var start = source.indexOf('it("Request new leave"');
    var end = source.indexOf('it("Check that correct warning messages are shown"', start);
    var block = source.slice(start, end);

    expect(start).to.be.at.least(0);
    expect(end).to.be.at.least(start);
    expect(block).to.match(/return submit_form_func\(\{/);
    expect(block).to.contain("submit_button_selector : '#book_leave_modal button[type=\"submit\"]'");
    expect(block).to.contain("modal_selector : '#book_leave_modal'");
    expect(block).to.contain('should_be_successful : false');
    expect(block).to.contain('message : /Failed to create a leave request/');
  });
});
