'use strict';

const config = require('../../lib/config');
const By = require('selenium-webdriver').By;
const expect = require('chai').expect;
const registerNewUser = require('../../lib/register_new_user');
const openPage = require('../../lib/open_page');

describe('Leave forecast stale-response handling', function() {
  this.timeout(config.get_execution_timeout());

  const applicationHost = config.get_application_host();
  let driver;

  after(async function() {
    if (driver) {
      await driver.quit();
      driver = null;
    }
  });

  it('creates an isolated company and opens the booking modal', async function() {
    const registration = await registerNewUser({
      application_host: applicationHost,
    });
    driver = registration.driver;

    await openPage({
      url: `${applicationHost}calendar/`,
      driver,
    });

    await driver.findElement(By.css('#book_time_off_btn')).click();
    await driver.sleep(400);
  });

  it('keeps a superseded forecast hidden after a required date is cleared', async function() {
    const setup = await driver.executeScript(function() {
      const $ = window.jQuery;
      const $form = $('.book-leave-form');
      const $forecast = $form.find('.book-leave-forecast');
      const $from = $form.find('input[name="from_date"]');
      const $to = $form.find('input[name="to_date"]');
      const $leaveType = $form.find('#leave_type');

      window.__leaveForecastReproduction = {
        calls: [],
        originalAjax: $.ajax,
      };

      $.ajax = function(options) {
        const deferred = $.Deferred();
        window.__leaveForecastReproduction.calls.push({
          deferred: deferred,
          options: options,
        });
        return deferred.promise();
      };

      if (!$leaveType.val()) {
        $leaveType.prop('selectedIndex', 1);
      }

      $leaveType.trigger('change');

      return {
        from: $from.val(),
        to: $to.val(),
        leaveType: $leaveType.val(),
        forecastHidden: $forecast.prop('hidden'),
      };
    });

    expect(setup.from).to.not.equal('');
    expect(setup.to).to.not.equal('');
    expect(setup.leaveType).to.not.equal('');
    expect(setup.forecastHidden).to.equal(true);

    await driver.sleep(450);

    const callsBeforeInvalidation = await driver.executeScript(function() {
      return window.__leaveForecastReproduction.calls.length;
    });
    expect(callsBeforeInvalidation).to.equal(1);

    await driver.executeScript(function() {
      const $ = window.jQuery;
      $('.book-leave-form input[name="from_date"]')
        .val('')
        .trigger('change');
    });
    await driver.sleep(450);

    const invalidatedState = await driver.executeScript(function() {
      const $forecast = window.jQuery('.book-leave-forecast');
      return {
        calls: window.__leaveForecastReproduction.calls.length,
        hidden: $forecast.prop('hidden'),
        text: $forecast.text(),
      };
    });

    expect(invalidatedState.calls).to.equal(1);
    expect(invalidatedState.hidden).to.equal(true);
    expect(invalidatedState.text).to.equal('');

    const finalState = await driver.executeScript(function() {
      const reproduction = window.__leaveForecastReproduction;
      reproduction.calls[0].deferred.resolve({
        ok: true,
        uses_allowance: false,
      });

      const $forecast = window.jQuery('.book-leave-forecast');
      return {
        hidden: $forecast.prop('hidden'),
        text: $forecast.text(),
      };
    });

    expect(finalState.hidden).to.equal(
      true,
      'a response superseded by clearing a required field must stay hidden'
    );
    expect(finalState.text).to.equal('');
  });
});
