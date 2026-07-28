'use strict';

const {By} = require('selenium-webdriver');
const {expect} = require('chai');
const config = require('../lib/config');
const registerNewUser = require('../lib/register_new_user');

describe('Destructive settings action safety', function() {
  this.timeout(config.get_execution_timeout());

  const applicationHost = config.get_application_host();
  let driver;

  before(async function() {
    const registration = await registerNewUser({
      application_host: applicationHost,
    });
    driver = registration.driver;
  });

  async function inspectRemoval({path, buttonSelector, formSelector}, confirmRemoval) {
    await driver.get(applicationHost + path);
    await driver.executeScript(function(selector, shouldConfirm) {
      const form = document.querySelector(selector);
      window.__destructiveActionSafety = {
        actionBefore: form.getAttribute('action'),
        confirmCalls: 0,
        confirmationMessagePresent: false,
        nativeSubmits: 0,
      };
      window.confirm = function(message) {
        window.__destructiveActionSafety.confirmCalls += 1;
        window.__destructiveActionSafety.confirmationMessagePresent =
          typeof message === 'string' && message.trim().length > 0;
        return shouldConfirm;
      };
      form.submit = function() {
        window.__destructiveActionSafety.nativeSubmits += 1;
      };
    }, formSelector, confirmRemoval);

    await driver.findElement(By.css(buttonSelector)).click();
    await driver.sleep(100);

    return driver.executeScript(function(selector) {
      const result = window.__destructiveActionSafety;
      result.actionAfter = document.querySelector(selector).getAttribute('action');
      return result;
    }, formSelector);
  }

  [
    {
      label: 'leave type',
      path: 'settings/general/',
      buttonSelector: '.leavetype-remove-btn',
      formSelector: '#delete_leavetype_form',
    },
    {
      label: 'bank holiday',
      path: 'settings/bankholidays/?year=2015',
      buttonSelector: '.bankholiday-remove-btn',
      formSelector: '#delete_bankholiday_form',
    },
  ].forEach(function(surface) {
    it('allows cancelling ' + surface.label + ' removal before submission', async function() {
      const result = await inspectRemoval(surface, false);

      expect(result.confirmCalls).to.equal(1);
      expect(result.confirmationMessagePresent).to.equal(true);
      expect(result.nativeSubmits).to.equal(0);
      expect(result.actionAfter).to.equal(result.actionBefore);
    });

    it('submits ' + surface.label + ' removal once after confirmation', async function() {
      const result = await inspectRemoval(surface, true);

      expect(result.confirmCalls).to.equal(1);
      expect(result.confirmationMessagePresent).to.equal(true);
      expect(result.nativeSubmits).to.equal(1);
      expect(result.actionAfter).to.match(/\/delete\/\d+\/$/);
    });
  });

  after(async function() {
    if (driver) await driver.quit();
  });
});
