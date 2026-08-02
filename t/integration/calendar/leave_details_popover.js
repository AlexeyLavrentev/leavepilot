'use strict';

const config = require('../../lib/config');
const setViewport = require('../../lib/set_viewport');
const models = require('../../../lib/model/db');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const By = require('selenium-webdriver').By;
const Key = require('selenium-webdriver').Key;
const until = require('selenium-webdriver').until;
const expect = require('chai').expect;

const registerNewUser = require('../../lib/register_new_user');
const addNewUser = require('../../lib/add_new_user');
const loginUser = require('../../lib/login_with_user');
const logoutUser = require('../../lib/logout_user');
const openPage = require('../../lib/open_page');

describe('Interactive leave details popover — all first-party surfaces', function() {
  this.timeout(config.get_execution_timeout());

  const applicationHost = config.get_application_host();
  const employeeEmail = `leave-popover-${Date.now()}@test.com`;
  let driver;
  let adminEmail;
  let admin;
  let employee;
  let rangeStart;
  let rangeEnd;
  let testYear;

  after(async function() {
    if (driver) {
      await driver.quit();
      driver = null;
      process.stdout.write('\n[leave-popover] WebDriver closed after suite\n');
    }
  });

  function nextFriday() {
    const date = moment().tz('Europe/London').add(10, 'days').startOf('day');
    while (date.isoWeekday() !== 5) {
      date.add(1, 'day');
    }
    return date;
  }

  async function createLeave(user, leaveType, start, end, status) {
    return models.Leave.create({
      userId: user.id,
      approverId: admin.id,
      leaveTypeId: leaveType.id,
      date_start: start.format('YYYY-MM-DD'),
      date_end: end.format('YYYY-MM-DD'),
      status,
      employee_comment: `Interactive popover fixture ${start.format('YYYY-MM-DD')}`,
    });
  }

  async function triggerVisible(trigger) {
    return driver.executeScript(function(element) {
      const instance = window.jQuery(element).data('bs.popover');
      const tip = instance && instance.tip();
      return !!(tip && tip.is(':visible'));
    }, trigger);
  }

  async function waitVisible(trigger, expected, timeout) {
    return driver.wait(async function() {
      return (await triggerVisible(trigger)) === expected;
    }, timeout || 2000);
  }

  async function popoverInfo(trigger) {
    return driver.executeScript(function(element) {
      const id = element.getAttribute('aria-describedby') || '';
      const tip = id ? document.getElementById(id) : null;
      return {
        id,
        expanded: element.getAttribute('aria-expanded'),
        role: tip ? tip.getAttribute('role') : null,
        text: tip ? (tip.textContent || '').trim() : '',
      };
    }, trigger);
  }

  async function visibleLeavePopoverCount() {
    return driver.executeScript(function() {
      let count = 0;
      document.querySelectorAll('.interactive-leave-details-summary-trigger').forEach(function(trigger) {
        const instance = window.jQuery(trigger).data('bs.popover');
        const tip = instance && instance.tip();
        if (tip && tip.is(':visible')) { count += 1; }
      });
      return count;
    });
  }

  async function visiblePopoverWithinViewport() {
    return driver.executeScript(function() {
      const tip = document.querySelector('.popover.in');
      if (!tip) { return false; }
      const rect = tip.getBoundingClientRect();
      return rect.left >= -1
        && rect.right <= window.innerWidth + 1
        && rect.top >= -1
        && rect.bottom <= window.innerHeight + 1;
    });
  }

  async function installAjaxHarness() {
    return driver.executeScript(function() {
      window.__leaveAjaxHarness = {
        original: window.jQuery.ajax,
        requests: [],
      };
      window.jQuery.ajax = function(options) {
        if (options.url.indexOf('/calendar/leave-summary/') !== 0) {
          return window.__leaveAjaxHarness.original.apply(this, arguments);
        }
        const record = {options, aborted: false};
        const xhr = {
          abort: function() {
            if (record.aborted) { return; }
            record.aborted = true;
            if (options.error) { options.error(xhr, 'abort'); }
            if (options.complete) { options.complete(xhr, 'abort'); }
          },
        };
        record.xhr = xhr;
        window.__leaveAjaxHarness.requests.push(record);
        return xhr;
      };
    });
  }

  async function applyTheme(theme) {
    return driver.executeScript(function(value) {
      if (value === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
    }, theme);
  }

  async function captureScreenshot(directory, name) {
    const image = await driver.takeScreenshot();
    fs.writeFileSync(path.join(directory, `${name}.png`), image, 'base64');
  }

  it('creates a synthetic company, two employees, and leave fixtures', async function() {
    const registration = await registerNewUser({application_host: applicationHost});
    driver = registration.driver;
    adminEmail = registration.email;
    await addNewUser({driver, application_host: applicationHost, email: employeeEmail});

    admin = await models.User.findOne({where: {email: adminEmail}});
    employee = await models.User.findOne({where: {email: employeeEmail}});
    await employee.update({name: 'Lovelace,', lastname: 'Ada'});
    await employee.reload();
    const leaveType = await models.LeaveType.findOne({where: {companyId: admin.companyId}});
    expect(admin).to.not.equal(null);
    expect(employee).to.not.equal(null);
    expect(leaveType).to.not.equal(null);
    rangeStart = nextFriday();
    rangeEnd = rangeStart.clone().add(3, 'days');
    testYear = rangeStart.year();
    await models.BankHoliday.create({
      name: 'Interactive popover holiday',
      date: rangeStart.format('YYYY-MM-DD'),
      companyId: admin.companyId,
    });
    await createLeave(employee, leaveType, rangeStart, rangeEnd, models.Leave.status_approved());
    await createLeave(
      employee,
      leaveType,
      rangeStart.clone().add(7, 'days'),
      rangeStart.clone().add(7, 'days'),
      models.Leave.status_new()
    );
    await createLeave(
      employee,
      leaveType,
      rangeStart.clone().add(14, 'days'),
      rangeStart.clone().add(14, 'days'),
      models.Leave.status_new()
    );
    await createLeave(
      admin,
      leaveType,
      rangeStart.clone().add(21, 'days'),
      rangeStart.clone().add(21, 'days'),
      models.Leave.status_approved()
    );
  });

  it('reports the real browser and desktop viewport used by the suite', async function() {
    const capabilities = await driver.getCapabilities();
    const viewport = await driver.manage().window().getRect();
    const browserName = capabilities.get('browserName');
    const browserVersion = capabilities.get('browserVersion');
    expect(browserName).to.match(/^chrome/);
    expect(viewport.width).to.equal(1024);
    expect(viewport.height).to.equal(768);
    process.stdout.write(`\n[leave-popover] ${browserName} ${browserVersion}, headless=${!process.env.SHOW_CHROME}, viewport=${viewport.width}x${viewport.height}\n`);
  });

  it('opens the employee personal calendar with leave buttons on weekend and bank-holiday cells', async function() {
    await logoutUser({application_host: applicationHost, driver});
    await loginUser({application_host: applicationHost, driver, user_email: employeeEmail});
    await openPage({
      url: `${applicationHost}calendar/?show_full_year=1&year=${testYear}`,
      driver,
    });
    const triggers = await driver.findElements(By.css('.calendar-leave-details-trigger'));
    const weekends = await driver.findElements(By.css('.calendar_weekend_cell .calendar-leave-details-trigger'));
    const holidays = await driver.findElements(By.css('.bank_holiday_cell .calendar-leave-details-trigger'));
    expect(triggers.length).to.be.at.least(4);
    expect(weekends.length, 'leave remains interactive on a weekend').to.be.at.least(1);
    expect(holidays.length, 'leave remains interactive on a bank holiday').to.be.at.least(1);
  });

  it('personal trigger has a date name and opens an AJAX-backed tooltip immediately on focus', async function() {
    const trigger = await driver.findElement(By.css('.calendar-leave-details-trigger'));
    const tag = await trigger.getTagName();
    const name = await trigger.getAttribute('aria-label');
    expect(tag).to.equal('button');
    expect(name).to.match(/leave summary/i);
    expect(name).to.contain(String(testYear));
    expect(name).to.match(new RegExp(`\\d{1,2} \\S+ ${testYear}`));

    await driver.executeScript(function(element) { element.focus(); }, trigger);
    await waitVisible(trigger, true, 1500);
    await driver.wait(async function() {
      return (await trigger.getAttribute('aria-expanded')) === 'true';
    }, 1500);
    let info = await popoverInfo(trigger);
    expect(info.id).to.not.equal('');
    expect(info.role).to.equal('tooltip');
    expect(info.expanded).to.equal('true');
    await driver.wait(async function() {
      info = await popoverInfo(trigger);
      return info.text.length > 0 && !/loading/i.test(info.text);
    }, 4000);
  });

  it('personal Escape closes and preserves trigger focus', async function() {
    await openPage({
      url: `${applicationHost}calendar/?show_full_year=1&year=${testYear}`,
      driver,
    });
    const trigger = await driver.findElement(By.css('.calendar-leave-details-trigger'));
    await driver.executeScript(function(element) { element.focus(); }, trigger);
    await waitVisible(trigger, true);
    await trigger.sendKeys(Key.ESCAPE);
    await waitVisible(trigger, false);
    expect(await driver.executeScript(function(element) {
      return document.activeElement === element;
    }, trigger)).to.equal(true);
  });

  it('personal Enter reopens after Escape without a new focus event', async function() {
    const trigger = await driver.findElement(By.css('.calendar-leave-details-trigger'));
    await trigger.sendKeys(Key.ENTER);
    await waitVisible(trigger, true);
  });

  it('personal Space reopens after Escape without a new focus event', async function() {
    const trigger = await driver.findElement(By.css('.calendar-leave-details-trigger'));
    await trigger.sendKeys(Key.ESCAPE);
    await waitVisible(trigger, false);
    await trigger.sendKeys(Key.SPACE);
    await waitVisible(trigger, true);
  });

  it('personal focusout closes after the hide delay', async function() {
    const trigger = await driver.findElement(By.css('.calendar-leave-details-trigger'));
    const heading = await driver.findElement(By.css('h1'));
    await driver.actions().move({origin: heading}).perform();
    await trigger.sendKeys(Key.TAB);
    await waitVisible(trigger, false);
    expect(await trigger.getAttribute('aria-expanded')).to.equal('false');
  });

  it('Team View leave trigger names the employee and full date', async function() {
    await logoutUser({application_host: applicationHost, driver});
    await loginUser({application_host: applicationHost, driver, user_email: adminEmail});
    await openPage({url: `${applicationHost}calendar/teamview/?months=12`, driver});
    await driver.wait(until.elementLocated(By.css('.team-view-leave-details-trigger')), 5000);
    const triggers = await driver.findElements(By.css('.team-view-leave-details-trigger'));
    expect(triggers.length).to.be.at.least(2);
    const labelEvidence = await driver.executeScript(function() {
      return Array.from(document.querySelectorAll('.team-view-leave-details-trigger')).map(function(trigger) {
        const row = trigger.closest('.teamview-user-list-row');
        const name = row && row.querySelector('.team-view-employee-link, .team-view-employee-name');
        return {
          label: trigger.getAttribute('aria-label') || '',
          name: name ? (name.textContent || '').trim() : '',
        };
      });
    });
    labelEvidence.forEach(function(item) {
      expect(item.name).to.not.equal('');
      expect(item.label).to.contain(item.name);
      expect(item.label).to.contain(String(testYear));
    });
    const commaLabel = labelEvidence.find(item => item.name === 'Lovelace, Ada');
    expect(commaLabel).to.not.equal(undefined);
    expect((commaLabel.label.match(/Lovelace, Ada/g) || [])).to.have.length(1);
    expect(commaLabel.label).to.match(/Lovelace, Ada, \d{1,2} \S+ \d{4}/);
    expect(commaLabel.label).not.to.contain('Ada, Ada');

    let commaTrigger;
    for (const trigger of triggers) {
      const label = await trigger.getAttribute('aria-label');
      if (label.includes('Lovelace, Ada')) {
        commaTrigger = trigger;
        break;
      }
    }
    expect(commaTrigger).to.not.equal(undefined);
    await driver.executeScript(function(element) { element.focus(); }, commaTrigger);
    await waitVisible(commaTrigger, true);
    await commaTrigger.sendKeys(Key.ESCAPE);
    await waitVisible(commaTrigger, false);
    await commaTrigger.sendKeys(Key.TAB);
  });

  it('Team View honors the 700ms hover delay and keeps the tip hoverable', async function() {
    const trigger = await driver.findElement(By.css('.team-view-leave-details-trigger'));
    // The preceding test ends on a Tab, which focuses the next trigger and opens
    // its popover. That popover covers the trigger this test wants to hover, so
    // the synthetic pointer move lands on the popover and the trigger never sees
    // mouseenter. Start from a closed state instead of inheriting one.
    await driver.executeScript(function() {
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
    });
    await driver.actions().move({origin: await driver.findElement(By.css('h1'))}).perform();
    await driver.wait(async function() {
      return (await visibleLeavePopoverCount()) === 0;
    }, 3000, 'a popover from the previous test stayed open');
    await driver.actions().move({origin: trigger}).perform();
    await driver.sleep(300);
    expect(await triggerVisible(trigger)).to.equal(false);
    await driver.sleep(550);
    await waitVisible(trigger, true);

    const describedBy = await trigger.getAttribute('aria-describedby');
    const tip = await driver.findElement(By.id(describedBy));
    await driver.actions().move({origin: tip}).perform();
    await driver.sleep(250);
    expect(await triggerVisible(trigger), 'moving from trigger to tip keeps it open').to.equal(true);
    const heading = await driver.findElement(By.css('h1'));
    await driver.actions().move({origin: heading}).perform();
    await waitVisible(trigger, false);
  });

  it('Team View cancels a pending hover when another employee trigger opens', async function() {
    await openPage({url: `${applicationHost}calendar/teamview/?months=12`, driver});
    const triggers = await driver.findElements(By.css('.team-view-leave-details-trigger'));
    expect(triggers.length).to.be.at.least(2);
    await driver.actions().move({origin: triggers[0]}).perform();
    await driver.sleep(60);
    const pendingBefore = await driver.executeScript(function(element) {
      const state = window.jQuery(element).data('leaveSummaryState');
      return !!(state && state.showTimer);
    }, triggers[0]);
    expect(pendingBefore).to.equal(true);
    await driver.executeScript(function(element) { element.focus(); }, triggers[1]);
    await waitVisible(triggers[1], true);
    await driver.sleep(800);
    expect(await triggerVisible(triggers[0])).to.equal(false);
    expect(await visibleLeavePopoverCount()).to.equal(1);
    expect(await driver.executeScript(function(element) {
      const state = window.jQuery(element).data('leaveSummaryState');
      return !!(state && state.showTimer);
    }, triggers[0])).to.equal(false);
  });

  it('Team View nested leave button is not captured by horizontal navigation after scroll', async function() {
    const trigger = await driver.findElement(By.css('.team-view-leave-details-trigger'));
    await driver.executeScript(function(element) {
      const container = element.closest('.team-view-table-container');
      container.scrollLeft = container.scrollWidth;
      element.scrollIntoView({block: 'center', inline: 'center'});
      window.__leaveNestedDefaultPrevented = null;
      window.jQuery(document).one('keydown.leavePopoverNavigationTest', function(event) {
        window.__leaveNestedDefaultPrevented = event.isDefaultPrevented();
      });
      element.focus();
    }, trigger);
    await trigger.sendKeys(Key.ARROW_RIGHT);
    await driver.sleep(150);
    expect(await driver.executeScript(function() {
      return window.__leaveNestedDefaultPrevented;
    })).to.equal(false);
    await trigger.sendKeys(Key.ENTER);
    await waitVisible(trigger, true);
    await driver.executeScript(function() {
      window.jQuery(document).off('keydown.leavePopoverNavigationTest');
      delete window.__leaveNestedDefaultPrevented;
    });
  });

  it('Requests renders both sections as non-submitting date buttons', async function() {
    await openPage({url: `${applicationHost}requests/`, driver});
    const approve = await driver.findElements(By.css('.requests-to-approve-table .leave-details-date-trigger'));
    const own = await driver.findElements(By.css('.user-requests-table .leave-details-date-trigger'));
    expect(approve.length).to.be.at.least(2);
    expect(own.length).to.be.at.least(1);
    expect(await approve[0].getTagName()).to.equal('button');
    expect(await own[0].getTagName()).to.equal('button');
    expect(await approve[0].getAttribute('type')).to.equal('button');
    expect(await own[0].getAttribute('type')).to.equal('button');
    expect(await approve[0].getAttribute('href')).to.equal(null);
    expect(await own[0].getAttribute('href')).to.equal(null);
  });

  it('Requests real clicks toggle without URL or form side effects; inside and outside clicks behave', async function() {
    const approve = await driver.findElement(By.css('.requests-to-approve-table .leave-details-date-trigger'));
    const urlBefore = await driver.getCurrentUrl();
    await driver.executeScript(function() {
      window.__leaveFormSubmitCount = 0;
      window.jQuery('form').on('submit.leaveDetailsTest', function() {
        window.__leaveFormSubmitCount += 1;
      });
    });
    await approve.click();
    await waitVisible(approve, true);
    expect(await driver.getCurrentUrl()).to.equal(urlBefore);
    expect(await visibleLeavePopoverCount()).to.equal(1);

    const tipId = await approve.getAttribute('aria-describedby');
    const tip = await driver.findElement(By.id(tipId));
    await driver.actions().move({origin: tip}).click().perform();
    await driver.sleep(180);
    expect(await triggerVisible(approve), 'inside click keeps pinned popover open').to.equal(true);

    const heading = await driver.findElement(By.css('h1'));
    await driver.actions().move({origin: heading}).click().perform();
    await waitVisible(approve, false);
    expect(await driver.executeScript(function() { return window.__leaveFormSubmitCount; })).to.equal(0);

    await approve.click();
    await waitVisible(approve, true);
    await approve.click();
    await waitVisible(approve, false);
    expect(await driver.getCurrentUrl()).to.equal(urlBefore);
    expect(await driver.executeScript(function() { return window.__leaveFormSubmitCount; })).to.equal(0);
  });

  it('Requests single-open switches from to-approve to own-request dates', async function() {
    const approve = await driver.findElement(By.css('.requests-to-approve-table .leave-details-date-trigger'));
    const own = await driver.findElement(By.css('.user-requests-table .leave-details-date-trigger'));
    await approve.click();
    await waitVisible(approve, true);
    await own.click();
    await waitVisible(own, true);
    await waitVisible(approve, false);
    expect(await visibleLeavePopoverCount()).to.equal(1);
  });

  it('AJAX race A to B aborts A and ignores its forced late success', async function() {
    await openPage({url: `${applicationHost}requests/`, driver});
    await installAjaxHarness();
    const triggers = await driver.findElements(By.css('.leave-details-date-trigger'));
    expect(triggers.length).to.be.at.least(2);
    await driver.executeScript(function(element) { element.focus(); }, triggers[0]);
    await waitVisible(triggers[0], true);
    await driver.executeScript(function(element) { element.focus(); }, triggers[1]);
    await waitVisible(triggers[1], true);

    await driver.executeScript(function() {
      const requests = window.__leaveAjaxHarness.requests;
      requests[1].options.success('<strong>response B wins</strong>');
      requests[1].options.complete(requests[1].xhr, 'success');
      requests[0].options.success('<strong>stale response A</strong>');
    });
    const evidence = await driver.executeScript(function() {
      const harness = window.__leaveAjaxHarness;
      const visible = document.querySelector('.popover.in .leave-summary-popover-content');
      return {
        count: harness.requests.length,
        firstAborted: harness.requests[0].aborted,
        text: visible ? visible.textContent : '',
        visibleCount: document.querySelectorAll('.popover.in').length,
        hasError: visible ? visible.textContent.indexOf('request failed') !== -1 : false,
      };
    });
    expect(evidence.count).to.equal(2);
    expect(evidence.firstAborted).to.equal(true);
    expect(evidence.text).to.contain('response B wins');
    expect(evidence.text).not.to.contain('stale response A');
    expect(evidence.visibleCount).to.equal(1);
    expect(evidence.hasError).to.equal(false);
  });

  it('same-trigger reopen keeps request 2 current and ignores request 1', async function() {
    await openPage({url: `${applicationHost}requests/`, driver});
    await installAjaxHarness();
    const trigger = await driver.findElement(By.css('.leave-details-date-trigger'));
    await driver.executeScript(function(element) { element.focus(); }, trigger);
    await waitVisible(trigger, true);
    await trigger.sendKeys(Key.ESCAPE);
    await waitVisible(trigger, false);
    await trigger.sendKeys(Key.ENTER);
    await waitVisible(trigger, true);
    await driver.executeScript(function() {
      const requests = window.__leaveAjaxHarness.requests;
      requests[1].options.success('<strong>second response</strong>');
      requests[1].options.complete(requests[1].xhr, 'success');
      requests[0].options.success('<strong>first stale response</strong>');
    });
    const evidence = await driver.executeScript(function() {
      const requests = window.__leaveAjaxHarness.requests;
      const content = document.querySelector('.popover.in .leave-summary-popover-content');
      return {
        count: requests.length,
        firstAborted: requests[0].aborted,
        text: content ? content.textContent : '',
      };
    });
    expect(evidence.count).to.equal(2);
    expect(evidence.firstAborted).to.equal(true);
    expect(evidence.text).to.contain('second response');
    expect(evidence.text).not.to.contain('first stale response');
  });

  it('captures the required responsive/theme matrix with geometry evidence', async function() {
    this.timeout(config.get_execution_timeout() * 3);
    const directory = '/tmp/timeoff-stage6a-leave-popover';
    const matrix = [
      {width: 1440, height: 900, theme: 'light'},
      {width: 1440, height: 900, theme: 'dark'},
      {width: 1024, height: 768, theme: 'light'},
      {width: 768, height: 900, theme: 'light'},
      {width: 390, height: 844, theme: 'light'},
      {width: 390, height: 844, theme: 'dark'},
    ];
    const surfaces = [
      {
        name: 'calendar',
        url: `${applicationHost}calendar/?show_full_year=1&year=${testYear}`,
        selector: '.calendar-leave-details-trigger',
      },
      {
        name: 'team-view',
        url: `${applicationHost}calendar/teamview/?months=12`,
        selector: '.team-view-leave-details-trigger',
      },
      {
        name: 'requests',
        url: `${applicationHost}requests/`,
        selector: '.leave-details-date-trigger',
      },
    ];
    const manifest = [];
    fs.mkdirSync(directory, {recursive: true});

    for (const viewport of matrix) {
      await setViewport(driver, {
        width: viewport.width,
        height: viewport.height,
      });
      for (const surface of surfaces) {
        await openPage({url: surface.url, driver});
        await applyTheme(viewport.theme);
        const trigger = await driver.findElement(By.css(surface.selector));
        await driver.executeScript(function(element) { element.focus(); }, trigger);
        await waitVisible(trigger, true, 1800);
        await driver.wait(async function() {
          const info = await popoverInfo(trigger);
          return info.text.length > 0 && !/loading/i.test(info.text);
        }, 4000);

        const measurement = await driver.executeScript(function(element, surfaceName) {
          const triggerRect = element.getBoundingClientRect();
          const row = element.closest('tr');
          const rowRect = row ? row.getBoundingClientRect() : null;
          const cell = element.closest('td');
          const cellRect = cell ? cell.getBoundingClientRect() : null;
          const nextCellRect = cell && cell.nextElementSibling
            ? cell.nextElementSibling.getBoundingClientRect()
            : null;
          const id = element.getAttribute('aria-describedby');
          const tip = id ? document.getElementById(id) : null;
          const tipRect = tip ? tip.getBoundingClientRect() : null;
          const content = tip && tip.querySelector('.leave-summary-popover-content');
          const style = getComputedStyle(element);
          const pageOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          const container = element.closest('.team-view-table-container');
          const deducted = document.querySelector('.team-view-deducted-cell');
          return {
            surface: surfaceName,
            triggerWidth: triggerRect.width,
            triggerHeight: triggerRect.height,
            rowHeight: rowRect ? rowRect.height : null,
            cellWidth: cellRect ? cellRect.width : null,
            nextCellWidth: nextCellRect ? nextCellRect.width : null,
            halfCellWidthDelta: cellRect && nextCellRect
              ? Math.abs(cellRect.width - nextCellRect.width)
              : null,
            pageOverflow,
            outlineWidth: style.outlineWidth,
            expanded: element.getAttribute('aria-expanded'),
            describedBy: id || '',
            live: content ? content.getAttribute('aria-live') : null,
            atomic: content ? content.getAttribute('aria-atomic') : null,
            popoverWithinViewport: !!(tipRect
              && tipRect.left >= -1
              && tipRect.right <= window.innerWidth + 1
              && tipRect.top >= -1
              && tipRect.bottom <= window.innerHeight + 1),
            popoverBounds: tipRect ? {
              left: tipRect.left,
              right: tipRect.right,
              top: tipRect.top,
              bottom: tipRect.bottom,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
            } : null,
            tableOverflow: container ? container.scrollWidth - container.clientWidth : 0,
            stickyDeducted: deducted ? getComputedStyle(deducted).position : null,
          };
        }, trigger, surface.name);

        expect(measurement.expanded).to.equal('true');
        expect(measurement.describedBy).to.not.equal('');
        expect(measurement.live).to.equal('polite');
        expect(measurement.atomic).to.equal('true');
        expect(measurement.outlineWidth).to.not.equal('0px');
        expect(
          measurement.popoverWithinViewport,
          `${surface.name} ${viewport.width}x${viewport.height} ${viewport.theme} popover bounds ${JSON.stringify(measurement.popoverBounds)}`
        ).to.equal(true);
        expect(measurement.pageOverflow).to.be.at.most(1);
        if (surface.name === 'calendar') {
          expect(measurement.triggerWidth).to.be.at.least(24);
          expect(measurement.triggerHeight).to.be.at.least(24);
          expect(measurement.rowHeight).to.be.at.most(38);
          expect(measurement.halfCellWidthDelta).to.be.at.most(1);
        }
        if (surface.name === 'team-view') {
          expect(measurement.stickyDeducted).to.equal('sticky');
        }

        const fileName = `${surface.name}-${viewport.width}x${viewport.height}-${viewport.theme}`;
        await captureScreenshot(directory, fileName);
        manifest.push(Object.assign({
          file: `${fileName}.png`,
          viewport,
        }, measurement));
        await trigger.sendKeys(Key.ESCAPE);
      }
    }

    fs.writeFileSync(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );
    expect(manifest).to.have.length(matrix.length * surfaces.length);
    expect(manifest.some(function(item) {
      return item.surface === 'team-view'
        && item.viewport.width <= 768
        && item.tableOverflow > 0;
    }), 'Team View overflows inside its scroll container on a narrow viewport').to.equal(true);
  });

  it('captures loading, error, and loaded live-region states outside the repository', async function() {
    const directory = '/tmp/timeoff-stage6a-leave-popover';
    await setViewport(driver, {width: 390, height: 844});
    await openPage({url: `${applicationHost}requests/`, driver});
    await applyTheme('light');
    await installAjaxHarness();
    const trigger = await driver.findElement(By.css('.leave-details-date-trigger'));
    await driver.executeScript(function(element) {
      element.scrollIntoView({block: 'center', inline: 'center'});
      element.focus();
    }, trigger);
    await waitVisible(trigger, true);
    expect(await visiblePopoverWithinViewport(), 'loading state stays in viewport').to.equal(true);
    await captureScreenshot(directory, 'requests-390x844-light-loading');

    await driver.executeScript(function() {
      const request = window.__leaveAjaxHarness.requests[0];
      request.options.error(request.xhr, 'error');
      request.options.complete(request.xhr, 'error');
    });
    expect(await visiblePopoverWithinViewport(), 'error state stays in viewport').to.equal(true);
    await captureScreenshot(directory, 'requests-390x844-light-error');

    await trigger.sendKeys(Key.ESCAPE);
    await waitVisible(trigger, false);
    await trigger.sendKeys(Key.ENTER);
    await waitVisible(trigger, true);
    await driver.executeScript(function() {
      const request = window.__leaveAjaxHarness.requests[1];
      request.options.success('<strong>Loaded visual state</strong>');
      request.options.complete(request.xhr, 'success');
    });
    expect(await visiblePopoverWithinViewport(), 'loaded state stays in viewport').to.equal(true);
    await captureScreenshot(directory, 'requests-390x844-light-loaded');
    fs.writeFileSync(
      path.join(directory, 'state-manifest.json'),
      `${JSON.stringify([
        'requests-390x844-light-loading.png',
        'requests-390x844-light-error.png',
        'requests-390x844-light-loaded.png',
      ], null, 2)}\n`,
      'utf8'
    );
  });

  it('validates mobile pointer proxy, page scroll, outside toggle, and Team View table scroll', async function() {
    await setViewport(driver, {width: 390, height: 844});
    const surfaces = [
      {
        url: `${applicationHost}calendar/?show_full_year=1&year=${testYear}`,
        selector: '.calendar-leave-details-trigger',
      },
      {
        url: `${applicationHost}calendar/teamview/?months=12`,
        selector: '.team-view-leave-details-trigger',
      },
      {
        url: `${applicationHost}requests/`,
        selector: '.leave-details-date-trigger',
      },
    ];

    for (const surface of surfaces) {
      await openPage({url: surface.url, driver});
      const trigger = await driver.findElement(By.css(surface.selector));
      await driver.executeScript(function(element) {
        element.scrollIntoView({block: 'center', inline: 'center'});
      }, trigger);
      await driver.sleep(100);
      await trigger.click();
      await waitVisible(trigger, true);
      await trigger.click();
      await waitVisible(trigger, false);
      await trigger.click();
      await waitVisible(trigger, true);
      const heading = await driver.findElement(By.css('h1'));
      await driver.actions().move({origin: heading}).click().perform();
      await waitVisible(trigger, false);

      const scrollEvidence = await driver.executeScript(function() {
        const container = document.querySelector('.team-view-table-container');
        if (container) {
          container.scrollLeft = Math.min(120, container.scrollWidth - container.clientWidth);
          return {kind: 'table', moved: container.scrollLeft > 0};
        }
        window.scrollTo(0, Math.min(120, document.documentElement.scrollHeight - window.innerHeight));
        return {
          kind: 'page',
          moved: document.documentElement.scrollHeight <= window.innerHeight || window.scrollY > 0,
        };
      });
      expect(scrollEvidence.moved, `${scrollEvidence.kind} scroll remains available`).to.equal(true);
    }
    process.stdout.write('\n[leave-popover] mobile input: real Selenium pointer proxy at 390x844; CDP touch emulation not used\n');
  });
});
