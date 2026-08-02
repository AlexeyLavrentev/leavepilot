'use strict';

/* globals describe, it, before, after */

/*
 * Stage 8M — rendered Reminder Schedules Workspace contract.
 *
 * Exercises local create/update/delete API calls through the real page. Test
 * email delivery is intentionally not triggered; the existing API unit suite
 * replaces the mail transport and verifies that boundary safely.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var webdriver = require('selenium-webdriver');
var By = webdriver.By;
var Key = webdriver.Key;
var until = webdriver.until;
var config = require('../../lib/config');
var registerNewUser = require('../../lib/register_new_user');
var openPage = require('../../lib/open_page');

var SCREEN_DIR = '/tmp/stage8m-reminder-schedules';

async function setViewport(driver, width, height) {
  await driver.manage().window().setRect({ width: width, height: height });
  await driver.sleep(180);
}

async function openSchedules(driver, host) {
  await openPage({ url: host + 'settings/reminder-schedules/', driver: driver });
  await driver.wait(until.elementLocated(By.css('.reminder-schedules-page')), 4000);
  await driver.wait(async function () {
    return driver.executeScript(function () {
      var empty = document.getElementById('schedule-empty');
      var rows = document.querySelectorAll('[data-reminder-schedule-row]');
      return rows.length > 0 || (empty && !empty.classList.contains('hidden'));
    });
  }, 4000);
}

async function setLanguage(driver, host, locale) {
  await openPage({ url: host + 'language/' + locale, driver: driver });
  await openSchedules(driver, host);
}

async function collapseMobileNav(driver) {
  var openNav = await driver.findElements(By.css('.navbar-collapse.in'));
  if (openNav.length) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.wait(until.elementIsNotVisible(openNav[0]), 1200);
  }
}

async function setTheme(driver, theme) {
  var mobileToggle = await driver.findElements(By.css('.navbar-toggle'));
  if (mobileToggle.length && await mobileToggle[0].isDisplayed()) {
    if (await mobileToggle[0].getAttribute('aria-expanded') !== 'true') {
      await mobileToggle[0].click();
      await driver.sleep(180);
    }
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(220);
  await collapseMobileNav(driver);
}

async function capture(driver, name) {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
  var target = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(target, await driver.takeScreenshot(), 'base64');
  assert(fs.statSync(target).size > 0, 'screenshot must be non-empty: ' + target);
}

async function replaceValue(element, value) {
  await element.clear();
  await element.sendKeys(String(value));
}

async function openAddModal(driver, selector) {
  await driver.findElement(By.css(selector || '#add-schedule')).click();
  var modal = await driver.findElement(By.css('#schedule-modal'));
  await driver.wait(until.elementIsVisible(modal), 2000);
  await driver.sleep(350);
  return modal;
}

async function closeModal(driver) {
  var modal = await driver.findElement(By.css('#schedule-modal'));
  var cancel = await driver.findElement(By.css('#schedule-modal .modal-footer [data-dismiss="modal"]'));
  await cancel.click();
  await driver.wait(until.elementIsNotVisible(modal), 2000);
}

async function createSchedule(driver, days, entrySelector) {
  var modal = await openAddModal(driver, entrySelector);
  await replaceValue(await driver.findElement(By.css('#schedule-days')), days);
  await driver.findElement(By.css('#schedule-form .modal-footer .btn-success')).click();
  await driver.wait(until.elementIsNotVisible(modal), 3000);
  await driver.wait(async function () {
    return driver.executeScript(function (expected) {
      return Array.prototype.some.call(
        document.querySelectorAll('.reminder-schedule-days'),
        function (cell) { return cell.textContent.trim() === 'T−' + expected; }
      );
    }, String(days));
  }, 3000);
}

var MOBILE_GEOMETRY = function () {
  var page = document.querySelector('.reminder-schedules-page');
  var findings = [];
  var ranges = 0;
  var boxes = 0;
  var tolerance = 1;

  function hidden(element) {
    if (element.closest && (
      element.closest('.sr-only') ||
      element.closest('.mobile-card-table thead')
    )) return true;
    while (element && element !== document.body) {
      var style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          element.getAttribute('aria-hidden') === 'true') return true;
      element = element.parentElement;
    }
    return false;
  }

  function inspect(container, label) {
    if (hidden(container)) return;
    var boundary = container.getBoundingClientRect();
    if (container.scrollWidth > container.clientWidth + 2) {
      findings.push(label + ' scrollWidth ' + container.scrollWidth + ' > ' + container.clientWidth);
    }
    if (container.scrollHeight > container.clientHeight + 2 && getComputedStyle(container).overflowY === 'hidden') {
      findings.push(label + ' clipped vertically');
    }

    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (!(node.nodeValue || '').trim() || hidden(node.parentElement)) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var index = 0; index < rects.length; index++) {
        var rect = rects[index];
        if (!rect.width || !rect.height) continue;
        ranges++;
        if (rect.left < boundary.left - tolerance || rect.right > boundary.right + tolerance ||
            rect.left < -tolerance || rect.right > window.innerWidth + tolerance) {
          findings.push(label + ' text [' + rect.left + ', ' + rect.right +
            '] outside [' + boundary.left + ', ' + boundary.right + ']');
        }
      }
    }

    var elements = container.querySelectorAll(
      'input:not([type="hidden"]), select, textarea, button, label, code, .reminder-status-chip'
    );
    for (var childIndex = 0; childIndex < elements.length; childIndex++) {
      var element = elements[childIndex];
      if (hidden(element)) continue;
      var box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      boxes++;
      if (box.left < boundary.left - tolerance || box.right > boundary.right + tolerance ||
          box.left < -tolerance || box.right > window.innerWidth + tolerance) {
        findings.push(label + ' ' + element.tagName + ' [' + box.left + ', ' + box.right +
          '] outside [' + boundary.left + ', ' + boundary.right + ']');
      }
    }
  }

  var surfaces = page.querySelectorAll('.surface');
  for (var surfaceIndex = 0; surfaceIndex < surfaces.length; surfaceIndex++) {
    inspect(surfaces[surfaceIndex], 'surface-' + surfaceIndex);
  }
  var rows = page.querySelectorAll('[data-reminder-schedule-row]');
  for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) inspect(rows[rowIndex], 'row-' + rowIndex);
  var visibleModal = page.querySelector('#schedule-modal.in');
  if (visibleModal) inspect(visibleModal.querySelector('.modal-content'), 'modal');

  return {
    surfaces: surfaces.length,
    rows: rows.length,
    ranges: ranges,
    boxes: boxes,
    findings: findings,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth
  };
};

async function assertMobileGeometry(driver, label, expectModal) {
  await driver.sleep(180);
  var result = await driver.executeScript(MOBILE_GEOMETRY);
  assert.strictEqual(result.surfaces, 2, '[' + label + '] expected two surfaces');
  assert(result.rows >= 2, '[' + label + '] expected non-vacuous schedule rows');
  assert(result.ranges > 0 && result.boxes > 0,
    '[' + label + '] geometry probe is vacuous: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.clientWidth + 1,
    '[' + label + '] document overflow: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.innerWidth + 1,
    '[' + label + '] viewport overflow: ' + JSON.stringify(result));
  assert.deepStrictEqual(result.findings, [],
    '[' + label + '] geometry violations: ' + JSON.stringify(result.findings.slice(0, 20)));
  if (expectModal) {
    assert(await driver.findElement(By.css('#schedule-modal')).isDisplayed(),
      '[' + label + '] modal must be visible');
  }
}

describe('Reminder Schedules interaction and visual contract (Stage 8M)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var host = config.get_application_host();

  before(function (done) {
    registerNewUser({ application_host: host }).then(function (data) {
      driver = data.driver;
      done();
    }, done);
  });

  after(async function () {
    if (driver) await driver.quit();
  });

  it('renders the scoped empty workspace with protected controls', async function () {
    await setViewport(driver, 1440, 900);
    await openSchedules(driver, host);
    var contract = await driver.executeScript(function () {
      return {
        headings: document.querySelectorAll('.reminder-schedules-page h1').length,
        surfaces: document.querySelectorAll('.reminder-schedules-page .surface').length,
        tableClasses: document.getElementById('schedule-table').className,
        tableHidden: document.getElementById('schedule-table-region').classList.contains('hidden'),
        emptyHidden: document.getElementById('schedule-empty').classList.contains('hidden'),
        feedbackRole: document.getElementById('schedule-feedback').getAttribute('role'),
        addType: document.getElementById('add-schedule').type,
        modalRole: document.getElementById('schedule-modal').getAttribute('role')
      };
    });
    assert.strictEqual(contract.headings, 1);
    assert.strictEqual(contract.surfaces, 2);
    assert(contract.tableClasses.indexOf('mobile-card-table') !== -1);
    assert.strictEqual(contract.tableHidden, true);
    assert.strictEqual(contract.emptyHidden, false);
    assert.strictEqual(contract.feedbackRole, 'status');
    assert.strictEqual(contract.addType, 'button');
    assert.strictEqual(contract.modalRole, 'dialog');
  });

  it('creates a schedule from the empty state and reports completion', async function () {
    await createSchedule(driver, 10, '#add-first-schedule');
    var state = await driver.executeScript(function () {
      var row = document.querySelector('[data-reminder-schedule-row]');
      var cells = row.querySelectorAll('td');
      return {
        rows: document.querySelectorAll('[data-reminder-schedule-row]').length,
        tableHidden: document.getElementById('schedule-table-region').classList.contains('hidden'),
        emptyHidden: document.getElementById('schedule-empty').classList.contains('hidden'),
        labels: Array.prototype.map.call(cells, function (cell) { return cell.getAttribute('data-label'); }),
        status: row.querySelector('.reminder-status-chip').textContent.trim(),
        feedbackRole: document.getElementById('schedule-feedback').getAttribute('role'),
        feedbackHidden: document.getElementById('schedule-feedback').classList.contains('hidden')
      };
    });
    assert.strictEqual(state.rows, 1);
    assert.strictEqual(state.tableHidden, false);
    assert.strictEqual(state.emptyHidden, true);
    assert.strictEqual(state.labels.length, 5);
    assert(state.labels.every(Boolean), 'every generated cell must have a localized label');
    assert.strictEqual(state.feedbackRole, 'status');
    assert.strictEqual(state.feedbackHidden, false);
  });

  it('edits and deactivates the schedule, then adds an active peer', async function () {
    await driver.findElement(By.css('.reminder-schedule-edit')).click();
    var modal = await driver.findElement(By.css('#schedule-modal'));
    await driver.wait(until.elementIsVisible(modal), 2000);
    await driver.sleep(350);
    var modalTitle = await driver.executeScript(
      'return document.getElementById("schedule-modal-title").textContent.trim()'
    );
    assert(modalTitle.length > 0, 'edit modal must keep its localized title');
    await replaceValue(await driver.findElement(By.css('#schedule-days')), 12);
    await driver.findElement(By.css('#schedule-active')).click();
    await driver.findElement(By.css('#schedule-form .modal-footer .btn-success')).click();
    await driver.wait(until.elementIsNotVisible(modal), 3000);
    var daysCell = await driver.findElement(By.css('.reminder-schedule-days'));
    await driver.wait(until.elementTextContains(daysCell, 'T−12'), 3000);
    assert(await driver.findElement(By.css('.reminder-status-inactive')).isDisplayed());

    await createSchedule(driver, 4, '#add-schedule');
    assert.strictEqual((await driver.findElements(By.css('[data-reminder-schedule-row]'))).length, 2);
    assert.strictEqual((await driver.findElements(By.css('.reminder-status-active'))).length, 1);
    assert.strictEqual((await driver.findElements(By.css('.reminder-status-inactive'))).length, 1);
  });

  it('keeps a complete mobile Tab walk visible and excludes the hidden modal', async function () {
    await setViewport(driver, 390, 844);
    await openSchedules(driver, host);
    await collapseMobileNav(driver);
    await driver.executeScript('document.querySelector(".reminder-schedules-page").focus()');
    var visited = [];
    var entered = false;
    for (var index = 0; index < 60; index++) {
      await driver.actions().sendKeys(Key.TAB).perform();
      var focus = await driver.executeScript(function () {
        var active = document.activeElement;
        return {
          inside: !!active.closest('.reminder-schedules-page'),
          id: active.id || '',
          classes: active.className || '',
          modal: !!active.closest('#schedule-modal'),
          outline: getComputedStyle(active).outlineStyle,
          displayed: active.offsetParent !== null
        };
      });
      if (focus.inside) {
        entered = true;
        visited.push(focus);
      } else if (entered) break;
    }
    assert(visited.length >= 9, 'Tab walk must cover the workspace non-vacuously');
    assert(visited.some(function (item) { return item.id === 'add-schedule'; }));
    assert(visited.some(function (item) { return item.id === 'schedule-table-region'; }));
    assert(visited.some(function (item) { return String(item.classes).indexOf('reminder-schedule-edit') !== -1; }));
    assert(visited.some(function (item) { return String(item.classes).indexOf('reminder-schedule-delete') !== -1; }));
    assert(visited.some(function (item) { return item.id === 'test-leave'; }));
    assert(visited.every(function (item) { return item.displayed && !item.modal; }),
      'hidden modal controls must stay out of the page Tab order');
    assert(visited.some(function (item) { return item.outline !== 'none'; }),
      'keyboard focus must be visibly styled');
  });

  it('mobile interactive targets meet 44px on the page and in the modal', async function () {
    await setViewport(driver, 390, 844);
    await openSchedules(driver, host);
    var pageSizes = await driver.executeScript(function () {
      return Array.prototype.map.call(document.querySelectorAll(
        '#add-schedule, .reminder-schedule-action-group .btn, ' +
        '#test-leave, #test-days, .reminder-test-submit'
      ), function (element) {
        var rect = element.getBoundingClientRect();
        return { label: element.id || element.className, width: rect.width, height: rect.height };
      });
    });
    assert(pageSizes.length >= 8, 'page target probe must be non-vacuous');
    pageSizes.forEach(function (size) {
      assert(size.height >= 43.5, size.label + ' height is ' + size.height);
    });

    await openAddModal(driver);
    var modalSizes = await driver.executeScript(function () {
      return Array.prototype.map.call(document.querySelectorAll(
        '#schedule-modal .form-control, #schedule-modal .reminder-schedule-option, ' +
        '#schedule-modal .reminder-schedule-active-option label, ' +
        '#schedule-modal .modal-footer .btn, #schedule-modal .close'
      ), function (element) {
        var rect = element.getBoundingClientRect();
        return { label: element.id || element.className, height: rect.height };
      }).filter(function (item) { return item.height > 0; });
    });
    assert(modalSizes.length >= 10, 'modal target probe must be non-vacuous');
    modalSizes.forEach(function (size) {
      assert(size.height >= 43.5, size.label + ' height is ' + size.height);
    });
    await closeModal(driver);
  });

  it('has bounded page and modal geometry in EN, RU, and KK at 390×844', async function () {
    await setViewport(driver, 390, 844);
    for (const locale of ['en', 'ru', 'kk']) {
      await setLanguage(driver, host, locale);
      await assertMobileGeometry(driver, locale + '-page', false);
      await openAddModal(driver);
      await assertMobileGeometry(driver, locale + '-modal', true);
      await closeModal(driver);
    }
    await setLanguage(driver, host, 'en');
  });

  it('status chips and supporting copy meet WCAG AA in light and dark', async function () {
    await setViewport(driver, 1200, 850);
    await openSchedules(driver, host);
    for (const theme of ['light', 'dark']) {
      await setTheme(driver, theme);
      var results = await driver.executeScript(function () {
        function channels(value) {
          return (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        }
        function luminance(value) {
          return channels(value).map(function (part) {
            part /= 255;
            return part <= 0.03928 ? part / 12.92 : Math.pow((part + 0.055) / 1.055, 2.4);
          }).reduce(function (sum, part, index) {
            return sum + part * [0.2126, 0.7152, 0.0722][index];
          }, 0);
        }
        function ratio(foreground, background) {
          var light = Math.max(luminance(foreground), luminance(background));
          var dark = Math.min(luminance(foreground), luminance(background));
          return (light + 0.05) / (dark + 0.05);
        }
        var surface = document.querySelector('.reminder-schedules-catalog');
        var description = document.querySelector('.reminder-schedules-section-heading p');
        return {
          chips: Array.prototype.map.call(document.querySelectorAll('.reminder-status-chip'), function (chip) {
            var style = getComputedStyle(chip);
            return ratio(style.color, style.backgroundColor);
          }),
          description: ratio(getComputedStyle(description).color, getComputedStyle(surface).backgroundColor)
        };
      });
      assert.strictEqual(results.chips.length, 2);
      results.chips.forEach(function (ratio) {
        assert(ratio >= 4.5, theme + ' chip contrast: ' + ratio);
      });
      assert(results.description >= 4.5, theme + ' supporting-copy contrast: ' + results.description);
    }
    await setTheme(driver, 'light');
  });

  it('neutralizes a real pressed transform under emulated reduced motion', async function () {
    await openSchedules(driver, host);
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    assert(await driver.executeScript(
      'return matchMedia("(prefers-reduced-motion: reduce)").matches'
    ));
    var button = await driver.findElement(By.css('#add-schedule'));
    await driver.actions().move({ origin: button }).press().perform();
    var transform = await driver.executeScript(
      'return getComputedStyle(arguments[0]).transform', button
    );
    await driver.actions().release().perform();
    assert.strictEqual(transform, 'none', 'reduced-motion press transform: ' + transform);
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
  });

  it('captures a 12-case overview and modal visual matrix', async function () {
    var cases = [
      ['en', 'overview', 1440, 900, 'light'],
      ['en', 'overview', 1440, 900, 'dark'],
      ['en', 'modal-add', 1440, 900, 'light'],
      ['en', 'modal-add', 1440, 900, 'dark'],
      ['en', 'overview', 390, 844, 'light'],
      ['en', 'overview', 390, 844, 'dark'],
      ['en', 'modal-edit', 390, 844, 'light'],
      ['en', 'modal-edit', 390, 844, 'dark'],
      ['ru', 'overview', 390, 844, 'light'],
      ['ru', 'modal-edit', 390, 844, 'dark'],
      ['kk', 'overview', 390, 844, 'light'],
      ['kk', 'modal-edit', 390, 844, 'dark']
    ];
    for (var index = 0; index < cases.length; index++) {
      var item = cases[index];
      await setViewport(driver, item[2], item[3]);
      await setLanguage(driver, host, item[0]);
      await setTheme(driver, item[4]);
      if (item[1] === 'modal-add') await openAddModal(driver);
      if (item[1] === 'modal-edit') {
        await driver.findElement(By.css('.reminder-schedule-edit')).click();
        var modal = await driver.findElement(By.css('#schedule-modal'));
        await driver.wait(until.elementIsVisible(modal), 2000);
        await driver.sleep(350);
      }
      await capture(driver, item[0] + '-' + item[1] + '-' + item[2] + '-' + item[4]);
      if (item[1] !== 'overview') await closeModal(driver);
    }
    await setLanguage(driver, host, 'en');
    await setTheme(driver, 'light');
    assert.strictEqual(fs.readdirSync(SCREEN_DIR).filter(function (file) {
      return file.endsWith('.png');
    }).length, 12);
  });

  it('requires native test-send input and makes schedule deletion cancellable', async function () {
    await setViewport(driver, 1200, 850);
    await openSchedules(driver, host);
    var testLeave = await driver.findElement(By.css('#test-leave'));
    await driver.findElement(By.css('.reminder-test-submit')).click();
    assert.strictEqual(await testLeave.getAttribute('value'), '');
    assert.strictEqual((await driver.findElements(By.css('[data-reminder-schedule-row]'))).length, 2);

    var firstDelete = await driver.findElement(By.css('.reminder-schedule-delete'));
    await firstDelete.click();
    var prompt = await driver.wait(until.alertIsPresent(), 1500);
    await prompt.dismiss();
    assert.strictEqual((await driver.findElements(By.css('[data-reminder-schedule-row]'))).length, 2,
      'dismissed confirmation must preserve the schedule');

    while ((await driver.findElements(By.css('.reminder-schedule-delete'))).length) {
      var previousCount = (await driver.findElements(By.css('[data-reminder-schedule-row]'))).length;
      await driver.findElement(By.css('.reminder-schedule-delete')).click();
      await (await driver.wait(until.alertIsPresent(), 1500)).accept();
      await driver.wait(async function () {
        return (await driver.findElements(By.css('[data-reminder-schedule-row]'))).length < previousCount;
      }, 3000);
    }
    assert(await driver.findElement(By.css('#schedule-empty')).isDisplayed());
    assert(await driver.findElement(By.css('#schedule-feedback.alert-success')).isDisplayed());
  });
});
