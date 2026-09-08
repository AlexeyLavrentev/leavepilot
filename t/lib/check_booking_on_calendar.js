'use strict';

const {By} = require('selenium-webdriver');
const {expect} = require('chai');

module.exports = async function({driver, type, full_days = [], halfs_1st_days = [], halfs_2nd_days = []}) {
  const classes = {
    pended: /\bleave_cell_pended\b/,
    approved: /\bleave_cell\b/,
    absent: /\bleave_cell(?:_pended)?\b/,
  };
  if (!Object.hasOwn(classes, type)) {
    throw new Error('Mandatory type parameter was not provided');
  }

  await Promise.all([
    {days: full_days, halves: ['half_1st', 'half_2nd']},
    {days: halfs_1st_days, halves: ['half_1st']},
    {days: halfs_2nd_days, halves: ['half_2nd']},
  ].flatMap(({days, halves}) => (days || []).flatMap(day => halves.map(async half => {
    const selector = `table.month_${day.format('MMMM')} td.day_${day.format('D')}.${half}`;
    const element = await driver.findElement(By.css(selector));
    const css = await element.getAttribute('class');
    if (type === 'absent') {
      expect(css, selector).not.to.match(classes.absent);
    } else {
      expect(css, selector).to.match(classes[type]);
    }
  }))));
  return {driver};
};
