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
    expect(scenarioSource[0]).to.match(/submit_button_selector\s*:\s*'#book_leave_modal button\[type="submit"\]'/);
  });
});

describe('revocation outcome contract', function(){
  for (const filename of ['leave_request_revoke.js', 'leave_request_revoke_by_admin.js']) {
    it(filename + ' checks the employee calendar after approval, not just a page reload', function(){
      const source = fs.readFileSync(path.join(__dirname, '..', 'integration', 'leave_request', filename), 'utf8');
      const start = source.indexOf("it('Employee calendar no longer contains the revoked leave'");
      expect(start).to.be.greaterThan(source.indexOf('it("Approve revoke request"'));
      const block = source.slice(start, source.indexOf('  after(', start));
      expect(block).to.contain('async function()');
      expect(block).to.match(/await logout_user_func[\s\S]*await login_user_func\(\{[^}]*user_email: email_employee/);
      expect(block).to.match(/await open_page_func\([^;]*calendar\/\?show_full_year=1/);
      expect(block).to.match(/await check_booking_func\(\{[\s\S]*type: 'absent'/);
      expect(block).to.match(/full_days: \[dayjs\.utc\(`\$\{currentYear\}-05-12`\)\]/);
      expect(block).to.match(/halfs_1st_days: \[dayjs\.utc\(`\$\{currentYear\}-05-11`\)\]/);
    });
  }
});
