'use strict';

/* globals describe, it, before, after */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var moment = require('moment');
var webdriver = require('selenium-webdriver');
var By = webdriver.By;
var Key = webdriver.Key;
var until = webdriver.until;
var config = require('../../lib/config');
var registerNewUser = require('../../lib/register_new_user');
var openPage = require('../../lib/open_page');
var submitForm = require('../../lib/submit_form');
var setUserStart = require('../../lib/set_user_to_start_at_the_beginning_of_the_year');

var SCREEN_DIR = '/tmp/stage8n-email-audit';

async function setViewport(driver, width, height) {
  await driver.manage().window().setRect({ width: width, height: height });
  await driver.sleep(180);
}

async function openAudit(driver, host) {
  await openPage({ url: host + 'audit/email/', driver: driver });
  await driver.wait(until.elementLocated(By.css('.email-audit-page')), 4000);
}

async function setLanguage(driver, host, locale) {
  await openPage({ url: host + 'language/' + locale, driver: driver });
  await openAudit(driver, host);
}

async function collapseMobileNav(driver) {
  var toggles = await driver.findElements(By.css('.navbar-toggle'));
  var navs = await driver.findElements(By.css('.navbar-collapse'));
  if (toggles.length && navs.length && await toggles[0].isDisplayed() && await navs[0].isDisplayed()) {
    await toggles[0].click();
    await driver.wait(until.elementIsNotVisible(navs[0]), 1200);
    await driver.sleep(350);
  }
}

async function setTheme(driver, theme) {
  var toggle = await driver.findElements(By.css('.navbar-toggle'));
  if (toggle.length && await toggle[0].isDisplayed()) {
    if ((await driver.findElements(By.css('.navbar-collapse.in'))).length === 0) {
      await toggle[0].click();
      await driver.wait(until.elementIsVisible(
        await driver.findElement(By.css('.navbar-collapse'))
      ), 1200);
      await driver.sleep(350);
    }
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(180);
  await collapseMobileNav(driver);
}

async function expandFirst(driver) {
  var trigger = await driver.findElement(By.css('.email-audit-subject'));
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  var detail = await driver.findElement(By.css('.email-audit-detail-row'));
  await driver.wait(until.elementIsVisible(detail), 1500);
  await driver.wait(async function () {
    return (await trigger.getAttribute('aria-expanded')) === 'true';
  }, 1500);
  return { trigger: trigger, detail: detail };
}

async function capture(driver, name) {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
  var target = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(target, await driver.takeScreenshot(), 'base64');
  assert(fs.statSync(target).size > 0, 'empty screenshot: ' + target);
}

var GEOMETRY = function () {
  var findings = [];
  var ranges = 0;
  var boxes = 0;
  var tolerance = 1;

  function hidden(element) {
    if (element.closest && (element.closest('.sr-only') || element.closest('.mobile-card-table thead'))) return true;
    while (element && element !== document.body) {
      var style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || element.getAttribute('aria-hidden') === 'true') return true;
      element = element.parentElement;
    }
    return false;
  }

  function inspect(container, label) {
    if (!container || hidden(container)) return;
    var boundary = container.getBoundingClientRect();
    if (container.scrollWidth > container.clientWidth + 2 && getComputedStyle(container).overflowX === 'hidden') {
      findings.push(label + ' clipped horizontally');
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
          findings.push(label + ' text outside bounds');
        }
      }
    }
    var elements = container.querySelectorAll('input, select, button, a, pre');
    for (var childIndex = 0; childIndex < elements.length; childIndex++) {
      var element = elements[childIndex];
      if (hidden(element)) continue;
      var box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      boxes++;
      if (box.left < boundary.left - tolerance || box.right > boundary.right + tolerance ||
          box.left < -tolerance || box.right > window.innerWidth + tolerance) {
        findings.push(label + ' ' + element.tagName + ' outside bounds');
      }
    }
  }

  var surfaces = document.querySelectorAll('.email-audit-page .surface');
  for (var surfaceIndex = 0; surfaceIndex < surfaces.length; surfaceIndex++) inspect(surfaces[surfaceIndex], 'surface-' + surfaceIndex);
  var entries = document.querySelectorAll('.vpp-email-audit-entry-header');
  for (var entryIndex = 0; entryIndex < entries.length; entryIndex++) inspect(entries[entryIndex], 'entry-' + entryIndex);
  inspect(document.querySelector('.email-audit-detail-row.in'), 'expanded-detail');

  return {
    surfaces: surfaces.length,
    entries: entries.length,
    ranges: ranges,
    boxes: boxes,
    findings: findings,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  };
};

async function assertGeometry(driver, label, expanded) {
  if (expanded) await expandFirst(driver);
  var result = await driver.executeScript(GEOMETRY);
  assert.strictEqual(result.surfaces, 2, '[' + label + '] surfaces');
  assert(result.entries > 0, '[' + label + '] entries');
  assert(result.ranges > 0 && result.boxes > 0, '[' + label + '] vacuous geometry');
  assert(result.scrollWidth <= result.clientWidth + 1, '[' + label + '] document overflow: ' + JSON.stringify(result));
  assert.deepStrictEqual(result.findings, [], '[' + label + '] ' + JSON.stringify(result.findings.slice(0, 20)));
}

describe('Email Audit interaction and visual contract (Stage 8N)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var userEmail;
  var host = config.get_application_host();

  before(async function () {
    var data = await registerNewUser({ application_host: host });
    driver = data.driver;
    userEmail = data.email;
    await setUserStart({ driver: driver, email: userEmail, year: moment.utc().year() });
    await openPage({ url: host, driver: driver });
    await driver.findElement(By.css('#book_time_off_btn')).click();
    await driver.sleep(700);
    var date = moment.utc().add(21, 'days');
    while (date.isoWeekday() > 5) date.add(1, 'day');
    await submitForm({
      driver: driver,
      form_params: [
        { selector: 'select[name="from_date_part"]', option_selector: 'option[value="2"]', value: '2' },
        { selector: 'input#from', value: date.format('YYYY-MM-DD') },
        { selector: 'input#to', value: date.format('YYYY-MM-DD') }
      ],
      message: /New leave request was added/
    });
    await openAudit(driver, host);
    await driver.wait(until.elementsLocated(By.css('.vpp-email-audit-entry-header')), 4000);
  });

  after(async function () {
    if (driver) await driver.quit();
  });

  it('renders the scoped workspace with real audit entries', async function () {
    var state = await driver.executeScript(function () {
      return {
        h1: document.querySelectorAll('.email-audit-page h1').length,
        surfaces: document.querySelectorAll('.email-audit-page .surface').length,
        entries: document.querySelectorAll('.vpp-email-audit-entry-header').length,
        collapsed: document.querySelectorAll('.email-audit-detail-row:not(.in)').length,
        headers: document.querySelectorAll('#email_list th[scope="col"]').length
      };
    });
    assert.strictEqual(state.h1, 1);
    assert.strictEqual(state.surfaces, 2);
    assert(state.entries > 0);
    assert.strictEqual(state.collapsed, state.entries);
    assert.strictEqual(state.headers, 3);
  });

  it('opens one disclosure by click and closes it by keyboard', async function () {
    var opened = await expandFirst(driver);
    assert(await opened.detail.findElement(By.css('a[href^="mailto:"]')).isDisplayed());
    assert((await opened.detail.findElement(By.css('.email-audit-body')).getText()).length > 0);
    await driver.sleep(400);
    await driver.executeScript('arguments[0].focus()', opened.trigger);
    await driver.actions().sendKeys(Key.ENTER).perform();
    await driver.wait(async function () {
      return (await opened.trigger.getAttribute('aria-expanded')) === 'false';
    }, 1500);
    await driver.wait(until.elementIsNotVisible(opened.detail), 1500);
    assert.strictEqual(await opened.trigger.getAttribute('aria-expanded'), 'false');
  });

  it('preserves employee filtering and reset navigation', async function () {
    await driver.findElement(By.css('.user-link-cell a')).click();
    await driver.wait(until.urlContains('user_id='), 2000);
    assert((await driver.findElement(By.css('#employee')).getAttribute('value')).length > 0);
    assert(await driver.findElement(By.css('.audit-filter-actions a[href="/audit/email/"]')).isDisplayed());
    assert((await driver.findElements(By.css('.vpp-email-audit-entry-header'))).length > 0);
  });

  it('keeps the complete mobile Tab path visible with 44px targets', async function () {
    await setViewport(driver, 390, 844);
    await collapseMobileNav(driver);
    var sizes = await driver.executeScript(function () {
      return Array.prototype.map.call(document.querySelectorAll(
        '.audit-filter .form-control, .audit-filter-actions .btn, .email-audit-table-container, ' +
        '.vpp-email-audit-entry-header a'
      ), function (element) {
        var rect = element.getBoundingClientRect();
        return { label: element.id || element.className, height: rect.height };
      }).filter(function (item) { return item.height > 0; });
    });
    assert(sizes.length >= 7, 'target probe is vacuous');
    sizes.forEach(function (size) { assert(size.height >= 43.5, size.label + ': ' + size.height); });

    await driver.executeScript('document.querySelector(".email-audit-page").focus()');
    var visited = [];
    var entered = false;
    for (var index = 0; index < 50; index++) {
      await driver.actions().sendKeys(Key.TAB).perform();
      var focus = await driver.executeScript(function () {
        var active = document.activeElement;
        return {
          inside: !!active.closest('.email-audit-page'),
          id: active.id || '',
          classes: active.className || '',
          visible: active.offsetParent !== null,
          outline: getComputedStyle(active).outlineStyle
        };
      });
      if (focus.inside) { entered = true; visited.push(focus); } else if (entered) break;
    }
    assert(visited.length >= 7, 'Tab walk is vacuous');
    assert(visited.some(function (item) { return item.id === 'start_date'; }));
    assert(visited.some(function (item) { return item.id === 'employee'; }));
    assert(visited.some(function (item) { return String(item.classes).indexOf('email-audit-subject') !== -1; }));
    assert(visited.every(function (item) { return item.visible; }));
    assert(visited.some(function (item) { return item.outline !== 'none'; }));
  });

  it('has bounded collapsed and expanded geometry in EN, RU, and KK', async function () {
    await setViewport(driver, 390, 844);
    for (const locale of ['en', 'ru', 'kk']) {
      await setLanguage(driver, host, locale);
      await assertGeometry(driver, locale + '-collapsed', false);
      await assertGeometry(driver, locale + '-expanded', true);
    }
    await setLanguage(driver, host, 'en');
  });

  it('meets WCAG AA for hierarchy and expanded content in both themes', async function () {
    await setViewport(driver, 1200, 850);
    await openAudit(driver, host);
    await expandFirst(driver);
    for (const theme of ['light', 'dark']) {
      await setTheme(driver, theme);
      var ratios = await driver.executeScript(function () {
        function rgb(value) { return (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number); }
        function luminance(value) {
          return rgb(value).map(function (part) {
            part /= 255;
            return part <= 0.03928 ? part / 12.92 : Math.pow((part + 0.055) / 1.055, 2.4);
          }).reduce(function (sum, part, index) { return sum + part * [0.2126, 0.7152, 0.0722][index]; }, 0);
        }
        function ratio(fg, bg) {
          var a = luminance(fg); var b = luminance(bg);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        }
        var surface = document.querySelector('.email-audit-results');
        var body = document.querySelector('.email-audit-body');
        return {
          heading: ratio(getComputedStyle(document.querySelector('#email-audit-results-heading')).color, getComputedStyle(surface).backgroundColor),
          subject: ratio(getComputedStyle(document.querySelector('.email-audit-subject')).color, getComputedStyle(surface).backgroundColor),
          body: ratio(getComputedStyle(body).color, getComputedStyle(body).backgroundColor)
        };
      });
      Object.keys(ratios).forEach(function (key) { assert(ratios[key] >= 4.5, theme + ' ' + key + ': ' + ratios[key]); });
    }
    await setTheme(driver, 'light');
  });

  it('neutralizes real pressed feedback under reduced motion', async function () {
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    var trigger = await driver.findElement(By.css('.email-audit-subject'));
    await driver.actions().move({ origin: trigger }).press().perform();
    var transform = await driver.executeScript('return getComputedStyle(arguments[0]).transform', trigger);
    await driver.actions().release().perform();
    assert.strictEqual(transform, 'none');
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
  });

  it('captures a 12-case visual matrix', async function () {
    var cases = [
      ['en', 1440, 900, 'light', false], ['en', 1440, 900, 'dark', false],
      ['en', 1440, 900, 'light', true], ['en', 1440, 900, 'dark', true],
      ['en', 390, 844, 'light', false], ['en', 390, 844, 'dark', false],
      ['en', 390, 844, 'light', true], ['en', 390, 844, 'dark', true],
      ['ru', 390, 844, 'light', false], ['ru', 390, 844, 'dark', true],
      ['kk', 390, 844, 'light', false], ['kk', 390, 844, 'dark', true]
    ];
    for (var index = 0; index < cases.length; index++) {
      var item = cases[index];
      await setViewport(driver, item[1], item[2]);
      await setLanguage(driver, host, item[0]);
      await setTheme(driver, item[3]);
      if (item[4]) {
        var opened = await expandFirst(driver);
        if (item[1] <= 390) {
          await driver.executeScript('arguments[0].scrollIntoView({block: "start"})', opened.trigger);
          await driver.sleep(180);
        }
      }
      await capture(driver, item[0] + '-' + item[1] + '-' + item[3] + '-' + (item[4] ? 'expanded' : 'collapsed'));
    }
    assert.strictEqual(fs.readdirSync(SCREEN_DIR).filter(function (file) { return file.endsWith('.png'); }).length, 12);
  });
});
