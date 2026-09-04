'use strict';

const {expect} = require('chai');
const fs = require('fs');
const path = require('path');

const ACTION_FILES = {
  't/integration/leave_request/basic_leave_request.js': 0,
  't/integration/leave_request/leave_request_revoke.js': 3,
  't/integration/leave_request/leave_request_revoke_by_admin.js': 3,
};

describe('post-action transition contract', function(){
  Object.entries(ACTION_FILES).forEach(function([file, expectedTransitions]){
    it(file + ' waits for its changed request state', function(){
      const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      const staleWaits = source.match(/until\.stalenessOf\(/g) || [];

      expect(source).not.to.match(/until\.elementLocated\(By\.css\(['"]h1['"]\)\)/);
      expect(staleWaits, 'request state transition waits').to.have.lengthOf(expectedTransitions);
      if (file === 't/integration/leave_request/basic_leave_request.js') {
        expect(source).to.include("'tr[vpp=\"pending_for__'+non_admin_user_email+'\"]'");
        expect(source).to.include('rows.length === 0');
      }
    });
  });
});
