'use strict';

const {expect} = require('chai');
const quarantine = require('../../../t/integration_quarantine');

describe('integration quarantine honesty', () => {
  it('rejects active quarantine entries without accountable metadata', () => {
    expect(() => quarantine.validate([{
      file: 'missing.js', issue: 'not-an-issue', owner: '', reason: '', expiresAt: '2099-01-01',
    }])).to.throw('quarantine');
  });

  it('rejects expired quarantine entries and treats active ones as red', () => {
    expect(() => quarantine.validate([{
      file: 'leave_request/basic_leave_request.js', issue: 'https://github.com/AlexeyLavrentev/timeoff/issues/1', owner: 'maintainer', reason: 'tracked', expiresAt: '2000-01-01',
    }])).to.throw('expired');
    expect(quarantine.evaluate([])).to.deep.equal({active: false, count: 0});
  });
});
