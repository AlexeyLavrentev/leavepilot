'use strict';

var fs = require('fs'),
    path = require('path'),
    expect = require('chai').expect;

var source = fs.readFileSync(path.join(__dirname, '../integration/leave_type/leave_type_limit_in_action.js'), 'utf8');

function section(start, end) {
  var startIndex = source.indexOf(start),
      endIndex = source.indexOf(end, startIndex);

  expect(startIndex, 'scenario section should exist').to.be.at.least(0);
  expect(endIndex, 'next scenario section should exist').to.be.at.least(startIndex);
  return source.slice(startIndex, endIndex);
}

function expectModalSubmitContract(subject) {
  expect(subject).to.match(/return submit_form_func\(\{[\s\S]*?submit_button_selector\s*:\s*'#book_leave_modal button\[type="submit"\]'[\s\S]*?modal_selector\s*:\s*'#book_leave_modal'/);
}

describe('leave type limit in action submit contract', function(){
  it('returns both leave-modal booking submits into Mocha', function(){
    expectModalSubmitContract(section(
      'it("Try to request new leave that exceed the limit"',
      'it("Add a request that fits under the limit"'
    ));
    expectModalSubmitContract(section(
      'it("Add a request that fits under the limit"',
      'after(function(done)'
    ));
  });

  it('returns the accepted booking calendar assertion before completion', function(){
    var accepted = section(
      'it("Add a request that fits under the limit"',
      'after(function(done)'
    );

    expect(accepted).to.match(/\.then\(function\(\)\{\s*return check_booking_func\(\{[\s\S]*?full_days\s*:\s*\[dayjs\.utc\('2015-06-16'\),dayjs\.utc\('2015-06-16'\),dayjs\.utc\('2015-06-17'\)\][\s\S]*?type\s*:\s*'pended'[\s\S]*?\}\)[\s\S]*?\.then\(function\(\)\{ done\(\);? \}\)\s*\.catch\(done\);/);
  });
});
