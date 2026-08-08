'use strict';

/*
  20260629000000-create-reminder-schedules declares four indexes in the options
  object it hands to queryInterface.createTable. createTable does not read
  them: run it against an empty database and you get the table and no indexes
  at all.

  It goes unnoticed because the model declares three of the same four and
  sequelize.sync(), which the test suite uses, does create them - so they exist
  everywhere except where the data is.

  Nothing behaves wrongly because of it here, unlike the same mistake in the
  premium edition: both the create and the update handler in
  lib/route/reminder_schedules.js look for a duplicate before writing, so the
  uniqueness holds without the database's help. This is the three plain
  indexes catching up with their declaration.

  The fourth, reminder_schedules_unique_per_company, is not created. It is
  unique over company, leave type and days before, where is_active - and MySQL,
  which production runs on, has no partial indexes. The model does not declare
  it at all, so nothing has ever run with it; creating it now would be adding a
  constraint on the strength of a line in a migration nobody has tested
  against.

  addIndex is guarded by a read of the existing indexes, so this is safe on a
  database where they were added by hand.
*/

const INDEXES = [
  {name: 'reminder_schedules_company_active', fields: ['company_id', 'is_active']},
  {name: 'reminder_schedules_leave_type', fields: ['leave_type_id']},
  {name: 'reminder_schedules_days_before', fields: ['days_before']},
];

module.exports = {
  async up(queryInterface) {
    const existing = (await queryInterface.showIndex('ReminderSchedules')).map(index => index.name);

    for (const index of INDEXES) {
      if (existing.includes(index.name)) {
        continue;
      }

      await queryInterface.addIndex('ReminderSchedules', index.fields, {name: index.name});
    }
  },

  async down(queryInterface) {
    const existing = (await queryInterface.showIndex('ReminderSchedules')).map(index => index.name);

    for (const index of INDEXES) {
      if (existing.includes(index.name)) {
        await queryInterface.removeIndex('ReminderSchedules', index.name);
      }
    }
  },
};
