'use strict';

const expect = require('chai').expect;
const dayjs = require('../../lib/util/date');
const Sequelize = require('sequelize');
const defineUser = require('../../lib/model/db/user');

describe('User active status on employment end date', function() {
  it('keeps the employee active through the stated end date', async function() {
    const sequelize = new Sequelize('sqlite::memory:', {logging: false});

    try {
      const User = defineUser(sequelize, Sequelize.DataTypes);
      const employee = User.build({
        email: 'end-date@test.com',
        password: 'hash',
        name: 'End',
        lastname: 'Date',
        end_date: '2026-07-17',
      });

      const today = dayjs.utc('2026-07-17').startOf('day');
      expect(employee.is_active(today)).to.equal(true);
    } finally {
      await sequelize.close();
    }
  });
});
