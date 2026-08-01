'use strict';

/* globals describe, it, before, after */

/* Stage 8H — runtime, geometry and visual contract for Bank Holidays. */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var webdriver = require('selenium-webdriver');
var By = webdriver.By;
var Key = webdriver.Key;
var until = webdriver.until;
var config = require('../../lib/config');
var register_new_user_func = require('../../lib/register_new_user');
var open_page_func = require('../../lib/open_page');

var SCREEN_DIR = '/tmp/stage8h-bank-holidays';
var workCalendarsEnabled = /(?:^|,)(?:all|work_calendars)(?:,|$)/
  .test(process.env.TIMEOFF_FEATURES || '');
var itWorkCalendars = workCalendarsEnabled ? it : it.skip;

function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
}

async function setViewport(driver, width, height) {
  await driver.manage().window().setRect({ width: width, height: height });
  await driver.sleep(180);
}

async function collapseMobileNav(driver) {
  var toggles = await driver.findElements(By.css('.navbar-toggle'));
  if (!toggles.length || !(await toggles[0].isDisplayed())) return;
  var expanded = await driver.executeScript(function () {
    var collapse = document.querySelector('.navbar-collapse');
    return !!(collapse && getComputedStyle(collapse).display !== 'none');
  });
  if (expanded) {
    await driver.executeScript('$(".navbar-collapse").collapse("hide")');
    await driver.sleep(400);
  }
}

async function setTheme(driver, theme) {
  var expand = await driver.executeScript(
    'var t=document.querySelector(".navbar-toggle");' +
    'return !!(t && getComputedStyle(t).display!=="none" && t.offsetWidth>0);'
  );
  if (expand) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(120);
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.wait(until.elementLocated(By.css('[data-theme-value="' + theme + '"]')), 1500);
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(120);
  if (theme === 'dark') {
    await driver.wait(until.elementLocated(By.css('html[data-theme="dark"]')), 1500);
  } else {
    await driver.wait(function () {
      return driver.executeScript(
        'return document.documentElement.getAttribute("data-theme") === null;'
      );
    }, 1500);
  }
  if (expand) await collapseMobileNav(driver);
}

async function setReducedMotion(driver, enabled) {
  await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
    features: [{
      name: 'prefers-reduced-motion',
      value: enabled ? 'reduce' : 'no-preference'
    }]
  });
  await driver.sleep(100);
}

async function capture(driver, name) {
  ensureScreenDir();
  var image = await driver.takeScreenshot();
  var target = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(target, image, 'base64');
  assert(fs.statSync(target).size > 0, 'screenshot must be non-empty: ' + target);
}

var MOBILE_GEOMETRY_SCRIPT = function () {
  var viewport = document.documentElement;
  var tolerance = 1;
  var findings = [];
  var ranges = 0;
  var boxes = 0;

  function rounded(value) { return Math.round(value * 10) / 10; }

  function record(kind, side, value, limit, where) {
    findings.push({
      kind: kind,
      side: side,
      value: rounded(value),
      limit: rounded(limit),
      where: where
    });
  }

  function hidden(element) {
    if (!element) return true;
    if (element.closest('.sr-only, [aria-hidden="true"], .modal:not(.in)')) return true;
    var style = getComputedStyle(element);
    return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
  }

  function inspect(block, label) {
    if (hidden(block)) return;
    var boundary = block.getBoundingClientRect();
    if (block.scrollWidth > block.clientWidth + 2) {
      record('scroll', 'width', block.scrollWidth, block.clientWidth, label);
    }
    if (block.scrollHeight > block.clientHeight + 2 && getComputedStyle(block).overflowY === 'hidden') {
      record('scroll', 'height', block.scrollHeight, block.clientHeight, label);
    }

    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (!(node.nodeValue || '').trim() || hidden(node.parentElement)) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var index = 0; index < rects.length; index++) {
        var rect = rects[index];
        if (rect.width <= 0 || rect.height <= 0) continue;
        ranges++;
        if (rect.left < boundary.left - tolerance) record('text', 'left<block', rect.left, boundary.left, label);
        if (rect.right > boundary.right + tolerance) record('text', 'right>block', rect.right, boundary.right, label);
        if (rect.left < -tolerance) record('text', 'left<viewport', rect.left, 0, label);
        if (rect.right > window.innerWidth + tolerance) {
          record('text', 'right>viewport', rect.right, window.innerWidth, label);
        }
      }
    }

    var children = block.querySelectorAll('input:not([type="hidden"]), select, button, a, label, table');
    for (var childIndex = 0; childIndex < children.length; childIndex++) {
      var child = children[childIndex];
      if (hidden(child)) continue;
      var box = child.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      boxes++;
      if (box.left < boundary.left - tolerance) record('element', 'left<block', box.left, boundary.left, label);
      if (box.right > boundary.right + tolerance) record('element', 'right>block', box.right, boundary.right, label);
      if (box.left < -tolerance) record('element', 'left<viewport', box.left, 0, label);
      if (box.right > window.innerWidth + tolerance) {
        record('element', 'right>viewport', box.right, window.innerWidth, label);
      }
    }
  }

  var blocks = document.querySelectorAll(
    '.bank-holidays-page .page-heading, .bank-holidays-calendar-switcher, .bank-holidays-year-toolbar, ' +
    '.bank-holidays-month-grid, .bank-holidays-editor, .bank-holiday-row, .bank-holidays-actions, ' +
    '.bank-holidays-import, .bank-holidays-import-controls, .bank-holidays-import-table'
  );
  for (var index = 0; index < blocks.length; index++) inspect(blocks[index], 'block-' + index);

  return {
    blocks: blocks.length,
    ranges: ranges,
    boxes: boxes,
    findings: findings,
    scrollWidth: viewport.scrollWidth,
    clientWidth: viewport.clientWidth,
    innerWidth: window.innerWidth
  };
};

async function assertMobileGeometry(driver, locale) {
  await driver.sleep(220);
  var result = await driver.executeScript(MOBILE_GEOMETRY_SCRIPT);
  var prefix = '[' + locale + '] ';
  assert(result.blocks >= 7, prefix + 'geometry blocks are missing');
  assert(result.ranges > 80 && result.boxes > 18,
    prefix + 'geometry probe is vacuous: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.clientWidth + 1,
    prefix + 'document overflow: ' + result.scrollWidth + ' > ' + result.clientWidth);
  assert(result.scrollWidth <= result.innerWidth + 1,
    prefix + 'viewport overflow: ' + result.scrollWidth + ' > ' + result.innerWidth);
  assert.strictEqual(result.findings.length, 0,
    prefix + 'geometry violations: ' + JSON.stringify(result.findings.slice(0, 20)));
}

describe('Bank Holidays interaction, geometry and visual matrix (Stage 8H)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var applicationHost = config.get_application_host();
  var pageUrl = applicationHost + 'settings/bankholidays/?year=2015';

  before(async function () {
    var data = await register_new_user_func({ application_host: applicationHost });
    driver = data.driver;
  });

  after(async function () {
    if (driver) await driver.quit();
  });

  async function openBankHolidays() {
    await open_page_func({ url: pageUrl, driver: driver });
    await driver.wait(until.elementLocated(By.css('.bank-holidays-page')), 2500);
  }

  it('renders the scoped shell, calendar and protected form endpoints', async function () {
    await setViewport(driver, 1440, 900);
    await openBankHolidays();
    var contract = await driver.executeScript(function () {
      function form(selector) {
        var element = document.querySelector(selector);
        return element && {
          method: element.method.toLowerCase(),
          path: new URL(element.action).pathname,
          search: new URL(element.action).search
        };
      }
      return {
        h1: document.querySelectorAll('.bank-holidays-page h1').length,
        surfaces: document.querySelectorAll('.bank-holidays-workspace > .surface').length,
        months: document.querySelectorAll('.bank-holidays-month-grid .calendar_month').length,
        current: document.querySelectorAll('.bank-holidays-calendar-switcher [aria-current="page"]').length,
        update: form('#update_bankholiday_form'),
        remove: form('#delete_bankholiday_form'),
        add: form('#add_new_bank_holiday_form'),
        rows: document.querySelectorAll('.bank-holiday-row').length,
        removeButtons: document.querySelectorAll('button.bankholiday-remove-btn').length
      };
    });
    assert.strictEqual(contract.h1, 1);
    assert.strictEqual(contract.surfaces, 2);
    assert.strictEqual(contract.months, 12);
    assert.strictEqual(contract.current, 1);
    assert.deepStrictEqual(contract.update, {
      method: 'post', path: '/settings/bankholidays/', search: '?year=2015'
    });
    assert.deepStrictEqual(contract.remove, {
      method: 'post', path: '/settings/bankholidays/delete/', search: ''
    });
    assert.deepStrictEqual(contract.add, {
      method: 'post', path: '/settings/bankholidays/', search: '?year=2015'
    });
    assert(contract.rows > 0, 'seeded holiday editor must not be empty');
    assert.strictEqual(contract.removeButtons, contract.rows);
  });

  it('desktop presents a two-column workspace and three month columns without overflow', async function () {
    await setViewport(driver, 1440, 900);
    await openBankHolidays();
    var layout = await driver.executeScript(function () {
      var workspace = document.querySelector('.bank-holidays-workspace');
      var calendar = document.querySelector('.bank-holidays-calendar-surface').getBoundingClientRect();
      var editor = document.querySelector('.bank-holidays-editor').getBoundingClientRect();
      var months = document.querySelectorAll('.bank-holidays-month-grid .month_container');
      return {
        workspaceColumns: getComputedStyle(workspace).gridTemplateColumns.split(' ').length,
        monthColumns: getComputedStyle(document.querySelector('.bank-holidays-month-grid')).gridTemplateColumns.split(' ').length,
        aligned: Math.abs(calendar.top - editor.top) <= 1,
        calendarBeforeEditor: calendar.right < editor.left,
        firstRowAligned: Math.abs(months[0].getBoundingClientRect().top - months[2].getBoundingClientRect().top) <= 1,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      };
    });
    assert.strictEqual(layout.workspaceColumns, 2);
    assert.strictEqual(layout.monthColumns, 3);
    assert.strictEqual(layout.aligned, true);
    assert.strictEqual(layout.calendarBeforeEditor, true);
    assert.strictEqual(layout.firstRowAligned, true);
    assert(layout.scrollWidth <= layout.clientWidth + 1, 'desktop overflow');
  });

  it('previous and next year links preserve the common-calendar week type', async function () {
    await openBankHolidays();
    var links = await driver.executeScript(function () {
      return Array.prototype.map.call(
        document.querySelectorAll('.bank-holidays-year-toolbar a'),
        function (element) {
          var url = new URL(element.href);
          return { year: url.searchParams.get('year'), weekType: url.searchParams.get('week_type') };
        }
      );
    });
    assert.deepStrictEqual(links, [
      { year: '2014', weekType: 'five_day' },
      { year: '2016', weekType: 'five_day' }
    ]);
    await driver.findElement(By.css('.bank-holidays-year-toolbar .period-navigation-side:last-child a')).click();
    await driver.wait(until.urlContains('year=2016'), 2000);
    var current = new URL(await driver.getCurrentUrl());
    assert.strictEqual(current.searchParams.get('week_type'), 'five_day');
  });

  it('opens and closes the add-holiday modal with real pointer input', async function () {
    await setViewport(driver, 1200, 850);
    await openBankHolidays();
    await driver.findElement(By.css('#add_new_bank_holiday_btn')).click();
    var modal = await driver.findElement(By.css('#add_new_bank_holiday_modal'));
    await driver.wait(until.elementIsVisible(modal), 2000);
    assert.strictEqual(await modal.getAttribute('aria-labelledby'), 'add_new_bank_holiday_modal_label');
    assert.strictEqual(await modal.findElement(By.css('[name="name__new"]')).getAttribute('required'), 'true');
    var cancel = await modal.findElement(By.css('.modal-footer [data-dismiss="modal"]'));
    await driver.executeScript('arguments[0].scrollIntoView({block:"center"})', cancel);
    await cancel.click();
    await driver.wait(until.elementIsNotVisible(modal), 1800);
  });

  itWorkCalendars('creates and selects a work calendar through the gated production forms', async function () {
    await setViewport(driver, 1200, 850);
    await openBankHolidays();
    await driver.findElement(By.css('[data-target="#add_work_calendar_modal"]')).click();
    var modal = await driver.findElement(By.css('#add_work_calendar_modal'));
    await driver.wait(until.elementIsVisible(modal), 2000);
    var name = await modal.findElement(By.css('input[name="name"]'));
    await name.sendKeys('Stage 8H operational calendar');
    await modal.findElement(By.css('button[type="submit"]')).click();
    await driver.wait(until.elementLocated(By.css('.bank-holidays-page .alert-success')), 2500);

    var calendarLink = await driver.findElement(By.xpath(
      "//nav[contains(@class,'bank-holidays-calendar-switcher')]//a[contains(normalize-space(.), 'Stage 8H operational calendar')]"
    ));
    await calendarLink.click();
    await driver.wait(until.urlContains('work_calendar='), 2000);
    var selected = await driver.executeScript(function () {
      var current = document.querySelector('.bank-holidays-calendar-switcher [aria-current="page"]');
      var removal = document.querySelector('.bank-holidays-danger-action form');
      return {
        label: current && current.textContent.trim(),
        removalPath: removal && new URL(removal.action).pathname,
        importSurface: !!document.querySelector('.bank-holidays-import')
      };
    });
    assert.strictEqual(selected.label, 'Stage 8H operational calendar');
    assert(/^\/settings\/bankholidays\/calendars\/delete\/\d+\/$/.test(selected.removalPath),
      'unexpected work-calendar delete endpoint: ' + selected.removalPath);
    assert.strictEqual(selected.importSurface, false, 'selected work calendar must not show common import');

    await driver.findElement(By.css('.bank-holidays-calendar-switcher a[href*="week_type="]')).click();
    await driver.wait(until.urlContains('week_type='), 2000);
  });

  it('mobile switches to one workspace and one month column with 44px targets', async function () {
    await setViewport(driver, 390, 844);
    await openBankHolidays();
    await collapseMobileNav(driver);
    var result = await driver.executeScript(function () {
      function rect(selector) {
        return Array.prototype.map.call(document.querySelectorAll(selector), function (element) {
          var box = element.getBoundingClientRect();
          return {
            label: element.id || element.name || element.textContent.trim().slice(0, 30),
            width: Math.round(box.width),
            height: Math.round(box.height),
            visible: element.offsetWidth > 0 && element.offsetHeight > 0
          };
        }).filter(function (item) { return item.visible; });
      }
      return {
        workspaceColumns: getComputedStyle(document.querySelector('.bank-holidays-workspace')).gridTemplateColumns.split(' ').length,
        monthColumns: getComputedStyle(document.querySelector('.bank-holidays-month-grid')).gridTemplateColumns.split(' ').length,
        tabs: rect('.bank-holidays-calendar-switcher a'),
        year: rect('.bank-holidays-year-toolbar .btn'),
        controls: rect('.bank-holidays-editor .form-control, .bank-holidays-import .form-control'),
        actions: rect('.bank-holidays-actions .btn, .bank-holiday-remove .btn, .bank-holidays-import .btn')
      };
    });
    assert.strictEqual(result.workspaceColumns, 1);
    assert.strictEqual(result.monthColumns, 1);
    var targets = result.tabs.concat(result.year, result.actions);
    assert(targets.length >= 5, 'touch target probe is vacuous');
    targets.forEach(function (target) {
      assert(target.width >= 44 && target.height >= 44, 'target <44px: ' + JSON.stringify(target));
    });
    assert(result.controls.length >= 3, 'form control probe is vacuous');
    result.controls.forEach(function (control) {
      assert(control.height >= 44, 'control <44px: ' + JSON.stringify(control));
    });
  });

  it('mobile Tab walk reaches switching, year, editor and actions, then exits visibly', async function () {
    await setViewport(driver, 390, 844);
    await openBankHolidays();
    await collapseMobileNav(driver);
    await driver.executeScript('document.body.focus()');
    var entered = false;
    var left = false;
    var ring = false;
    var reached = {};
    var sequence = [];
    for (var index = 0; index < 100; index++) {
      await driver.actions().sendKeys(Key.TAB).perform();
      var state = await driver.executeScript(function () {
        var element = document.activeElement;
        if (!element || element === document.body) return null;
        var style = getComputedStyle(element);
        return {
          inPage: !!(element.closest && element.closest('.bank-holidays-page')),
          visible: element.offsetWidth > 0 && element.offsetHeight > 0 &&
            style.visibility !== 'hidden' && style.display !== 'none',
          ring: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
          id: element.id || element.name || element.tagName,
          switcher: !!(element.closest && element.closest('.bank-holidays-calendar-switcher')),
          year: !!(element.closest && element.closest('.bank-holidays-year-toolbar')),
          field: /^(date|name|day_type)__/.test(element.name || ''),
          remove: element.classList && element.classList.contains('bankholiday-remove-btn'),
          add: element.id === 'add_new_bank_holiday_btn'
        };
      });
      if (!state) continue;
      sequence.push(state.id);
      if (state.inPage) {
        entered = true;
        assert(state.visible, 'hidden focus target: ' + JSON.stringify(state));
        ring = ring || state.ring;
        if (state.switcher) reached.switcher = true;
        if (state.year) reached.year = true;
        if (state.field) reached.field = true;
        if (state.remove) reached.remove = true;
        if (state.add) reached.add = true;
      } else if (entered) {
        left = true;
        break;
      }
    }
    assert(ring, 'no visible focus ring');
    assert.deepStrictEqual(reached, {
      switcher: true, year: true, field: true, remove: true, add: true
    }, 'Tab missed a region: ' + sequence.join(' -> '));
    assert(left, 'Tab did not leave the page');
  });

  it('mobile EN/RU/KK text, tables and controls remain within their surfaces and viewport', async function () {
    var locales = ['en', 'ru', 'kk'];
    for (var index = 0; index < locales.length; index++) {
      await open_page_func({ url: applicationHost + 'language/' + locales[index], driver: driver });
      await setViewport(driver, 390, 844);
      await openBankHolidays();
      await collapseMobileNav(driver);
      await assertMobileGeometry(driver, locales[index]);
    }
  });

  it('light and dark headings, helper text, tabs and fields meet WCAG AA', async function () {
    var themes = ['light', 'dark'];
    for (var themeIndex = 0; themeIndex < themes.length; themeIndex++) {
      await setViewport(driver, 1200, 850);
      await openBankHolidays();
      await setTheme(driver, themes[themeIndex]);
      var results = await driver.executeScript(function () {
        function rgb(value) { return value.match(/[\d.]+/g).map(Number).slice(0, 3); }
        function channel(value) {
          value /= 255;
          return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
        }
        function luminance(value) {
          var color = rgb(value);
          return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
        }
        function ratio(foreground, background) {
          var first = luminance(foreground);
          var second = luminance(background);
          return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
        }
        function opaqueBackground(element) {
          var current = element;
          while (current) {
            var background = getComputedStyle(current).backgroundColor;
            if (background && !/rgba?\([^)]*,\s*0\)/.test(background) && background !== 'rgba(0, 0, 0, 0)') return background;
            current = current.parentElement;
          }
          return getComputedStyle(document.body).backgroundColor;
        }
        var elements = document.querySelectorAll(
          '.bank-holidays-page h1, .bank-holidays-page h2, .bank-holidays-page .lead, ' +
          '.bank-holidays-calendar-switcher a, .bank-holiday-field label, .bank-holiday-field .form-control'
        );
        return Array.prototype.map.call(elements, function (element) {
          return {
            text: (element.textContent || element.value || '').trim().slice(0, 45),
            ratio: ratio(getComputedStyle(element).color, opaqueBackground(element))
          };
        }).filter(function (item) { return item.text; });
      });
      assert(results.length >= 10, themes[themeIndex] + ' contrast probe is vacuous');
      results.forEach(function (result) {
        assert(result.ratio >= 4.5,
          themes[themeIndex] + ' contrast <4.5: ' + JSON.stringify(result));
      });
    }
  });

  it('CDP reduced motion neutralizes transitions and compound press transforms', async function () {
    await setViewport(driver, 1200, 850);
    await openBankHolidays();
    await setReducedMotion(driver, true);
    var result = await driver.executeScript(function () {
      var button = document.querySelector('.bank-holidays-year-toolbar .btn');
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        transition: getComputedStyle(button).transitionDuration,
        rule: Array.prototype.some.call(document.styleSheets, function (sheet) {
          var rules;
          try { rules = sheet.cssRules; } catch (error) { return false; }
          return Array.prototype.some.call(rules, function (candidate) {
            return candidate.conditionText &&
              candidate.conditionText.indexOf('prefers-reduced-motion') > -1 &&
              candidate.cssText.indexOf('.bank-holidays-page') > -1 &&
              candidate.cssText.indexOf(':hover:active') > -1 &&
              candidate.cssText.indexOf('transform: none') > -1;
          });
        })
      };
    });
    assert.strictEqual(result.matches, true);
    assert(/(^|, )0s/.test(result.transition), 'transition not neutralized: ' + result.transition);
    assert.strictEqual(result.rule, true, 'reduced-motion compound rule missing');
    await setReducedMotion(driver, false);
  });

  it('captures the 12-frame desktop/mobile, theme and locale visual matrix', async function () {
    if (fs.existsSync(SCREEN_DIR)) {
      fs.readdirSync(SCREEN_DIR).filter(function (name) { return /\.png$/.test(name); }).forEach(function (name) {
        fs.unlinkSync(path.join(SCREEN_DIR, name));
      });
    }

    async function shot(name, width, height, theme, selector) {
      await setViewport(driver, width, height);
      await openBankHolidays();
      await setTheme(driver, theme);
      await collapseMobileNav(driver);
      await driver.executeScript(function (target) {
        if (target === 'top') window.scrollTo(0, 0);
        else document.querySelector(target).scrollIntoView({ block: 'start' });
      }, selector);
      await driver.sleep(150);
      await capture(driver, name);
    }

    await open_page_func({ url: applicationHost + 'language/en', driver: driver });
    await shot('desktop-light-top', 1440, 900, 'light', 'top');
    await shot('desktop-light-calendar', 1440, 900, 'light', '.bank-holidays-month-grid');
    await shot('desktop-light-editor', 1440, 900, 'light', '.bank-holidays-editor');
    await shot('desktop-dark-top', 1440, 900, 'dark', 'top');
    await shot('desktop-dark-calendar', 1440, 900, 'dark', '.bank-holidays-month-grid');
    await shot('desktop-dark-editor', 1440, 900, 'dark', '.bank-holidays-editor');
    await shot('mobile-light-top', 390, 844, 'light', 'top');
    await shot('mobile-light-calendar', 390, 844, 'light', '.bank-holidays-month-grid');
    await shot('mobile-dark-top', 390, 844, 'dark', 'top');
    await shot('mobile-dark-editor', 390, 844, 'dark', '.bank-holidays-editor');
    await open_page_func({ url: applicationHost + 'language/ru', driver: driver });
    await shot('mobile-ru-light', 390, 844, 'light', '.bank-holidays-editor');
    await open_page_func({ url: applicationHost + 'language/kk', driver: driver });
    await shot('mobile-kk-dark', 390, 844, 'dark', '.bank-holidays-month-grid');

    assert.strictEqual(
      fs.readdirSync(SCREEN_DIR).filter(function (name) { return /\.png$/.test(name); }).length,
      12
    );
  });
});
