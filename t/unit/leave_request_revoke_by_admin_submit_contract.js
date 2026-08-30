'use strict';

var expect = require('chai').expect,
    fs = require('fs'),
    path = require('path');

var scenarioSource = fs.readFileSync(
  path.join(__dirname, '..', 'integration', 'leave_request', 'leave_request_revoke_by_admin.js'),
  'utf8'
).match(/it\("Create new leave request"[\s\S]*?(?=\n\s{2}it\("Check that all days are marked as pended")/);

describe('admin revoke leave-request submit contract', function(){
  it('uses the explicit successful navigation and modal-close lifecycle', function(){
    expect(scenarioSource, 'Create new leave request scenario').to.not.equal(null);

    var submits = scenarioSource[0].match(/submit_form_func\(\{/g) || [];

    expect(submits).to.have.length(1);
    expect(scenarioSource[0]).to.match(/expect_navigation\s*:\s*true/);
    expect(scenarioSource[0]).to.match(/modal_selector\s*:\s*'#book_leave_modal'/);
  });
});
