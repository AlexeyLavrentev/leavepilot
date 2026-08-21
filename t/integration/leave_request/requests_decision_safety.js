'use strict';

const setViewport = require('../../lib/set_viewport');

const config = require('../../lib/config');
const models = require('../../../lib/model/db');
const dayjs = require('../../../lib/util/date');
const By = require('selenium-webdriver').By;
const Key = require('selenium-webdriver').Key;
const until = require('selenium-webdriver').until;
const expect = require('chai').expect;

const registerNewUser = require('../../lib/register_new_user');
const addNewUser = require('../../lib/add_new_user');
const openPage = require('../../lib/open_page');

describe('Requests decision-safety interaction', function() {
  this.timeout(config.get_execution_timeout());

  const applicationHost = config.get_application_host();
  const employeeEmail = `requests-safety-${Date.now()}@test.com`;
  let driver;
  let admin;
  let employee;
  let leaveStart;

  after(async function() {
    if (driver) {
      await driver.quit();
      driver = null;
      process.stdout.write('\n[requests-safety] WebDriver closed after suite\n');
    }
  });

  it('creates an isolated company with two pending requests', async function() {
    const registration = await registerNewUser({application_host: applicationHost});
    driver = registration.driver;
    await addNewUser({
      application_host: applicationHost,
      driver,
      email: employeeEmail,
    });

    admin = await models.User.findOne({where: {email: registration.email}});
    employee = await models.User.findOne({where: {email: employeeEmail}});
    await employee.update({name: 'Ada', lastname: 'Lovelace'});
    await employee.reload();

    const leaveType = await models.LeaveType.findOne({
      where: {companyId: admin.companyId},
    });
    leaveStart = dayjs.utc().add(40, 'days').startOf('day');

    for (let index = 0; index < 2; index += 1) {
      const start = leaveStart.clone().add(index * 7, 'days');
      await models.Leave.create({
        userId: employee.id,
        approverId: null,
        leaveTypeId: leaveType.id,
        status: models.Leave.status_new(),
        date_start: start.format('YYYY-MM-DD'),
        date_end: start.clone().add(2, 'days').format('YYYY-MM-DD'),
      });
    }
  });

  it('renders semantic sections and row-specific accessible names', async function() {
    await openPage({url: `${applicationHost}requests/`, driver});

    const headings = await driver.findElements(By.css('main h2.requests-section-heading'));
    expect(headings.length).to.equal(2);
    expect(await headings[0].getText()).to.not.equal('');
    expect(await headings[1].getText()).to.not.equal('');

    const checkboxes = await driver.findElements(By.css('.bulk-request-checkbox'));
    expect(checkboxes.length).to.equal(2);
    const selectionName = await checkboxes[0].getAttribute('aria-label');
    expect(selectionName).to.contain('Ada Lovelace');
    expect(selectionName).to.contain(String(leaveStart.year()));

    const row = await checkboxes[0].findElement(By.xpath('./ancestor::tr'));
    const approve = await row.findElement(By.css('input.btn-success'));
    const reject = await row.findElement(By.css('input.btn-warning'));
    expect(await approve.getAttribute('aria-label')).to.contain('Ada Lovelace');
    expect(await reject.getAttribute('aria-label')).to.contain('Ada Lovelace');

    const form = await driver.findElement(By.css('#bulk-action-form'));
    expect(await driver.executeScript('return arguments[0].hidden', form)).to.equal(true);
  });

  it('Space selects a row and immediately exposes contextual feedback', async function() {
    const checkbox = await driver.findElement(By.css('.bulk-request-checkbox'));
    await checkbox.sendKeys(Key.SPACE);

    await driver.wait(async function() {
      return driver.executeScript('return arguments[0].checked', checkbox);
    }, 2000);

    const row = await checkbox.findElement(By.xpath('./ancestor::tr'));
    const form = await driver.findElement(By.css('#bulk-action-form'));
    const info = await driver.executeScript(function(rowElement, formElement) {
      return {
        rowSelected: rowElement.classList.contains('is-selected'),
        formHidden: formElement.hidden,
        position: getComputedStyle(formElement).position,
        count: formElement.querySelector('.bulk-selected-count').textContent.trim(),
      };
    }, row, form);

    expect(info.rowSelected).to.equal(true);
    expect(info.formHidden).to.equal(false);
    expect(info.position).to.equal('fixed');
    expect(info.count).to.match(/1/);
  });

  it('clear selection hides the panel and returns focus to the first request', async function() {
    const clear = await driver.findElement(By.css('.bulk-clear-btn'));
    await clear.click();

    const checkbox = await driver.findElement(By.css('.bulk-request-checkbox'));
    const form = await driver.findElement(By.css('#bulk-action-form'));
    const info = await driver.executeScript(function(input, formElement) {
      return {
        checked: input.checked,
        formHidden: formElement.hidden,
        focused: document.activeElement === input,
        selectedRows: document.querySelectorAll(
          '.requests-to-approve-table tbody tr.is-selected'
        ).length,
      };
    }, checkbox, form);

    expect(info.checked).to.equal(false);
    expect(info.formHidden).to.equal(true);
    expect(info.focused).to.equal(true);
    expect(info.selectedRows).to.equal(0);
  });

  it('provides a full-width mobile selection target and keeps actions in view', async function() {
    await setViewport(driver, {width: 390, height: 844});
    await openPage({url: `${applicationHost}requests/`, driver});

    const selector = await driver.findElement(By.css('.bulk-request-selector'));
    const checkbox = await selector.findElement(By.css('.bulk-request-checkbox'));
    const selectorRect = await selector.getRect();
    expect(selectorRect.width).to.be.greaterThan(300);
    expect(selectorRect.height).to.be.at.least(44);

    await selector.click();
    const form = await driver.findElement(By.css('#bulk-action-form'));
    const row = await checkbox.findElement(By.xpath('./ancestor::tr'));
    const approve = await row.findElement(By.css('input.btn-success'));
    await driver.wait(async function() {
      return driver.executeScript(function(approveElement, formElement) {
        return approveElement.getBoundingClientRect().bottom
          <= formElement.getBoundingClientRect().top - 7;
      }, approve, form);
    }, 2000);

    const navigationToggle = await driver.findElement(By.css('.navbar-toggle'));
    await navigationToggle.click();
    const themeToggle = await driver.findElement(By.css('#theme-menu .dropdown-toggle'));
    await driver.wait(until.elementIsVisible(themeToggle), 2000);
    await themeToggle.click();
    const darkTheme = await driver.findElement(By.css('[data-theme-value="dark"]'));
    await driver.wait(until.elementIsVisible(darkTheme), 2000);
    await darkTheme.click();
    await driver.sleep(400);
    const navigationExpanded = await driver.executeScript(function() {
      return document.querySelector('.navbar-collapse').classList.contains('in');
    });
    if (navigationExpanded) {
      await navigationToggle.click();
    }
    await driver.sleep(500);

    const geometry = await driver.executeScript(function(input, approveElement, formElement) {
      const rect = formElement.getBoundingClientRect();
      const approveRect = approveElement.getBoundingClientRect();
      return {
        checked: input.checked,
        position: getComputedStyle(formElement).position,
        top: rect.top,
        bottom: rect.bottom,
        viewportHeight: window.innerHeight,
        approveBottom: approveRect.bottom,
        navigationExpanded: document.querySelector('.navbar-collapse')
          .classList.contains('in'),
      };
    }, checkbox, approve, form);

    expect(geometry.checked).to.equal(true);
    expect(geometry.position).to.equal('fixed');
    expect(geometry.top).to.be.at.least(0);
    expect(geometry.bottom).to.be.at.most(geometry.viewportHeight + 1);
    expect(geometry.navigationExpanded).to.equal(false);
    expect(geometry.approveBottom).to.be.at.most(geometry.top - 7);
  });

  it('keeps section-heading contrast above WCAG AA in dark theme', async function() {
    const ratio = await driver.executeScript(function() {
      document.documentElement.setAttribute('data-theme', 'dark');
      const heading = document.querySelector('.requests-section-heading');
      const foreground = getComputedStyle(heading).color.match(/\d+/g).map(Number);
      const background = getComputedStyle(document.body).backgroundColor
        .match(/\d+/g).map(Number);

      function channel(value) {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : Math.pow((normalized + 0.055) / 1.055, 2.4);
      }

      function luminance(rgb) {
        return 0.2126 * channel(rgb[0])
          + 0.7152 * channel(rgb[1])
          + 0.0722 * channel(rgb[2]);
      }

      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    });

    expect(ratio).to.be.at.least(4.5);
  });

  it('guards submit, preserves request inputs and announces processing', async function() {
    await setViewport(driver, {width: 1024, height: 768});
    await openPage({url: `${applicationHost}requests/`, driver});

    const checkbox = await driver.findElement(By.css('.bulk-request-checkbox'));
    await checkbox.click();
    const approve = await driver.findElement(By.css('.bulk-approve-btn'));
    const form = await driver.findElement(By.css('#bulk-action-form'));

    await driver.executeScript(function(formElement) {
      window.__requestsSafetySubmitCount = 0;
      formElement.addEventListener('submit', function(event) {
        event.preventDefault();
        window.__requestsSafetySubmitCount += 1;
      }, true);
    }, form);

    await approve.click();
    await driver.wait(async function() {
      return (await form.getAttribute('aria-busy')) === 'true';
    }, 2000);

    const state = await driver.executeScript(function(formElement, input) {
      return {
        submits: window.__requestsSafetySubmitCount,
        action: formElement.getAttribute('action'),
        busy: formElement.getAttribute('aria-busy'),
        requestDisabled: input.disabled,
        buttonsDisabled: Array.from(
          formElement.querySelectorAll('.bulk-action-buttons button')
        ).every(function(button) { return button.disabled; }),
        status: formElement.querySelector('.bulk-action-status').textContent.trim(),
      };
    }, form, checkbox);

    expect(state.submits).to.equal(1);
    expect(state.action).to.equal('/requests/bulk/approve/');
    expect(state.busy).to.equal('true');
    expect(state.requestDisabled).to.equal(false);
    expect(state.buttonsDisabled).to.equal(true);
    expect(state.status).to.match(/1/);
  });

  it('focuses the result alert after a real bulk decision redirect', async function() {
    await openPage({url: `${applicationHost}requests/`, driver});
    const checkbox = await driver.findElement(By.css('.bulk-request-checkbox'));
    await checkbox.click();
    const approve = await driver.findElement(By.css('.bulk-approve-btn'));
    await approve.click();

    const alert = await driver.wait(until.elementLocated(
      By.css('#requests-feedback [role="alert"]')
    ), 5000);
    await driver.wait(async function() {
      return driver.executeScript(
        'return document.activeElement === arguments[0]',
        alert
      );
    }, 2000);

    expect(await alert.getAttribute('tabindex')).to.equal('-1');
    expect(await alert.getText()).to.match(/1/);
    const remaining = await driver.findElements(By.css('.bulk-request-checkbox'));
    expect(remaining.length).to.equal(1);
  });
});
