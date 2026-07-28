'use strict';

const {By} = require('selenium-webdriver');
const {expect} = require('chai');
const buildDriver = require('../lib/build_driver');
const config = require('../lib/config');

describe('Single-click submission safety', function() {
  this.timeout(config.get_execution_timeout());

  const applicationHost = config.get_application_host();
  let driver;

  before(async function() {
    driver = await buildDriver();
  });

  beforeEach(async function() {
    await driver.get(applicationHost + 'login/');
  });

  it('keeps invalid non-empty email input in the native validation path', async function() {
    await driver.executeScript(function() {
      window.__singleClickNativeSubmits = 0;
      document.querySelector('#local_login_form').submit = function() {
        window.__singleClickNativeSubmits += 1;
      };
    });

    await driver.findElement(By.id('email_inp')).sendKeys('not-an-email');
    await driver.findElement(By.id('pass_inp')).sendKeys('123456');
    await driver.findElement(By.id('submit_login')).click();
    await driver.sleep(100);

    const result = await driver.executeScript(function() {
      const email = document.querySelector('#email_inp');
      const submit = document.querySelector('#submit_login');

      return {
        hasTypeMismatch: email.validity.typeMismatch,
        nativeSubmits: window.__singleClickNativeSubmits,
        submitDisabled: submit.disabled,
      };
    });

    expect(result.hasTypeMismatch).to.equal(true);
    expect(result.nativeSubmits).to.equal(
      0,
      'an invalid form must not reach native form submission'
    );
    expect(result.submitDisabled).to.equal(
      false,
      'the submit button must remain available after native validation rejects the form'
    );
  });

  it('disables the submit button when its nested content is activated', async function() {
    await driver.executeScript(function() {
      window.__singleClickNativeSubmits = 0;
      const form = document.querySelector('#local_login_form');
      const submit = document.querySelector('#submit_login');
      const inner = document.createElement('span');

      inner.id = 'single-click-inner-target';
      inner.textContent = submit.textContent;
      submit.textContent = '';
      submit.appendChild(inner);
      form.submit = function() {
        window.__singleClickNativeSubmits += 1;
      };
    });

    await driver.findElement(By.id('email_inp')).sendKeys('person@example.com');
    await driver.findElement(By.id('pass_inp')).sendKeys('123456');
    await driver.findElement(By.id('single-click-inner-target')).click();
    await driver.sleep(100);

    const result = await driver.executeScript(function() {
      const submit = document.querySelector('#submit_login');
      const inner = document.querySelector('#single-click-inner-target');

      return {
        nativeSubmits: window.__singleClickNativeSubmits,
        submitDisabled: submit.disabled,
        innerDisabled: inner.disabled === true,
      };
    });

    expect(result.nativeSubmits).to.equal(1);
    expect(result.submitDisabled).to.equal(
      true,
      'the submit button must be disabled when its nested content is activated'
    );
    expect(result.innerDisabled).to.equal(
      false,
      'nested presentation content must not receive the disabled state'
    );
  });

  after(async function() {
    if (driver) await driver.quit();
  });
});
