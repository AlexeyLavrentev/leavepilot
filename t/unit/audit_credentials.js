'use strict';

const
  expect = require('chai').expect,
  Models = require('../../lib/model/db'),
  {getAuditCaptureForUser, NEVER_AUDITED_ATTRIBUTES} = require('../../lib/model/audit');

/*
  The audit trail copies old and new values into the database verbatim, and both
  of its writers pass a whole user row: lib/route/users/index.js hashes an
  admin-submitted password into the object it audits, and its delete path
  enumerates every column of the record. The premium integration API then serves
  the table to any holder of a company's static token.
*/
describe('Audit trail never records credentials', function() {

  let created;
  let originalCreate;

  beforeEach(function() {
    created = [];
    originalCreate = Models.Audit.create;
    Models.Audit.create = row => {
      created.push(row);
      return Promise.resolve(row);
    };
  });

  afterEach(function() {
    Models.Audit.create = originalCreate;
  });

  const byUser = {id: 7, companyId: 1};

  const employee = {
    id:       42,
    email:    'employee@example.com',
    name:     'Old',
    lastname: 'Name',
    password: 'scrypt$16384$8$1$0ldsa1t$0ldha5h',
  };

  it('skips the password when an admin changes it alongside other fields', function() {
    return getAuditCaptureForUser({
      byUser,
      forUser: employee,
      newAttributes: {
        name:     'New',
        password: 'scrypt$16384$8$1$newsa1t$newha5h',
      },
    })().then(() => {
      expect(created.map(row => row.attribute)).to.deep.equal(['name']);
    });
  });

  it('skips the password when a user is deleted and every column is nulled', function() {
    const nulled = Object.assign(
      {},
      ...Object.keys(employee).map(key => ({[key]: null}))
    );

    return getAuditCaptureForUser({byUser, forUser: employee, newAttributes: nulled})()
      .then(() => {
        expect(created.map(row => row.attribute)).to.not.include('password');
        expect(created.length).to.be.above(0, 'the delete path still records the rest of the row');
      });
  });

  it('leaks no hash into any recorded value', function() {
    const hash = employee.password;

    return getAuditCaptureForUser({
      byUser,
      forUser: employee,
      newAttributes: {password: 'scrypt$16384$8$1$newsa1t$newha5h', admin: true},
    })().then(() => {
      const values = created.flatMap(row => [row.oldValue, row.newValue]);
      values.forEach(value => expect(value).to.not.contain('scrypt$'));
      expect(values).to.not.include(hash);
    });
  });

  /*
    The deny-list is a list of names, so a credential column added to User later
    would be audited again without anyone noticing. This fails when that happens.
  */
  it('covers every credential-looking column on the User model', function() {
    const suspicious = Object.keys(Models.User.rawAttributes)
      .filter(name => /password|secret|token|hash|credential/i.test(name))
      .filter(name => !NEVER_AUDITED_ATTRIBUTES.includes(name));

    expect(suspicious).to.deep.equal(
      [],
      'add these to NEVER_AUDITED_ATTRIBUTES in lib/model/audit.js, or rename them if they hold no credential'
    );
  });
});
