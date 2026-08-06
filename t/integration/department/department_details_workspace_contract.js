'use strict';

/* globals describe, it, before, after */

/* Stage 8G — runtime, geometry and visual contract for Department Details. */

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
const sizeViewport = require('../../lib/set_viewport');

var SCREEN_DIR = '/tmp/stage8g-department-details';

function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
}

async function setViewport(driver, width, height) {
  await sizeViewport(driver, { width: width, height: height });
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
  var page = document.querySelector('.department-details-page');
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

    var children = block.querySelectorAll('input:not([type="hidden"]), select, button, a, label');
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

  var blocks = page.querySelectorAll(
    '.page-heading, .department-details-breadcrumb, .department-details-nav, .department-details-surface, .department-details-actions'
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
  assert(result.blocks >= 5, prefix + 'geometry blocks are missing');
  assert(result.ranges > 10 && result.boxes > 8,
    prefix + 'geometry probe is vacuous: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.clientWidth + 1,
    prefix + 'document overflow: ' + result.scrollWidth + ' > ' + result.clientWidth);
  assert(result.scrollWidth <= result.innerWidth + 1,
    prefix + 'viewport overflow: ' + result.scrollWidth + ' > ' + result.innerWidth);
  assert.strictEqual(result.findings.length, 0,
    prefix + 'geometry violations: ' + JSON.stringify(result.findings.slice(0, 20)));
}

describe('Department Details interaction, geometry and visual matrix (Stage 8G)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var applicationHost = config.get_application_host();
  var departmentUrl;
  var departmentId;

  before(async function () {
    var data = await register_new_user_func({ application_host: applicationHost });
    driver = data.driver;
    await open_page_func({ url: applicationHost + 'settings/departments/', driver: driver });
    var link = await driver.findElement(By.css('a[data-vpp-department-name="1"]'));
    departmentUrl = await link.getAttribute('href');
    departmentId = departmentUrl.match(/\/edit\/(\d+)\//)[1];
  });

  after(async function () {
    if (driver) await driver.quit();
  });

  async function openDepartment() {
    await open_page_func({ url: departmentUrl, driver: driver });
    await driver.wait(until.elementLocated(By.css('.department-details-page')), 2500);
  }

  it('renders the scoped shell, one surface and every protected form endpoint', async function () {
    await setViewport(driver, 1440, 900);
    await openDepartment();
    var contract = await driver.executeScript(function () {
      function form(selector) {
        var element = document.querySelector(selector);
        return element && {
          method: element.method.toLowerCase(),
          path: new URL(element.action).pathname
        };
      }
      return {
        h1: document.querySelectorAll('.department-details-page h1').length,
        surfaces: document.querySelectorAll('.department-details-page .surface').length,
        edit: form('#department_edit_form'),
        remove: form('.department-details-danger-action form'),
        nameRequired: document.querySelector('#department_edit_form [name="name"]').required,
        manager: !!document.querySelector('#department_edit_form [name="boss_id"]'),
        allowance: !!document.querySelector('#department_edit_form [name="allowance"]'),
        holidays: !!document.querySelector('#department_edit_form [name="include_public_holidays"]'),
        accrued: !!document.querySelector('#department_edit_form [name="is_accrued_allowance"]'),
        workCalendar: !!document.querySelector('#department_edit_form [name="work_calendar_id"]'),
        modal: !!document.querySelector('#add_secondary_supervisers_modal')
      };
    });
    assert.strictEqual(contract.h1, 1);
    assert.strictEqual(contract.surfaces, 1);
    assert.deepStrictEqual(contract.edit, {
      method: 'post', path: '/settings/departments/edit/' + departmentId + '/'
    });
    assert.deepStrictEqual(contract.remove, {
      method: 'post', path: '/settings/departments/delete/' + departmentId + '/'
    });
    assert.strictEqual(contract.nameRequired, true);
    assert.strictEqual(contract.manager, true);
    assert.strictEqual(contract.allowance, true);
    assert.strictEqual(contract.holidays, true);
    assert.strictEqual(contract.accrued, true);
    assert.strictEqual(contract.workCalendar, true);
    assert.strictEqual(contract.modal, true);
  });

  it('desktop uses a sidebar/content layout with a single active destination', async function () {
    await setViewport(driver, 1440, 900);
    await openDepartment();
    var layout = await driver.executeScript(function () {
      var root = document.querySelector('.department-details-layout');
      var nav = document.querySelector('.department-details-nav').getBoundingClientRect();
      var surface = document.querySelector('.department-details-surface').getBoundingClientRect();
      return {
        columns: getComputedStyle(root).gridTemplateColumns.split(' ').length,
        aligned: Math.abs(nav.top - surface.top) <= 1,
        navBeforeContent: nav.right < surface.left,
        active: document.querySelectorAll('.department-details-nav [aria-current="page"]').length,
        documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      };
    });
    assert.strictEqual(layout.columns, 2);
    assert.strictEqual(layout.aligned, true);
    assert.strictEqual(layout.navBeforeContent, true);
    assert.strictEqual(layout.active, 1);
    assert(layout.documentWidth <= layout.clientWidth + 1, 'desktop overflow');
  });

  it('updates the department through the protected form and shows success feedback', async function () {
    await open_page_func({ url: applicationHost + 'language/en', driver: driver });
    await openDepartment();
    var newName = 'Stage 8G Department with an intentionally long responsive workspace name';
    var name = await driver.findElement(By.css('#department_edit_form input[name="name"]'));
    await name.clear();
    await name.sendKeys(newName);
    await driver.findElement(By.css('#save_changes_btn')).click();
    await driver.wait(until.elementLocated(By.css('.department-details-page .alert-success')), 2500);
    var message = await driver.findElement(By.css('.department-details-page .alert-success')).getText();
    assert(/Department .* was updated/.test(message), 'unexpected feedback: ' + message);
    assert.strictEqual(
      await driver.findElement(By.css('#department_edit_form input[name="name"]')).getAttribute('value'),
      newName
    );
    assert((await driver.findElement(By.css('.page-heading h1')).getText()).indexOf(newName) > -1);
  });

  it('the employees destination uses the current department filter', async function () {
    await openDepartment();
    var employees = await driver.findElement(By.css(
      '.department-details-nav a[href="/users/?department=' + departmentId + '"]'
    ));
    await employees.click();
    await driver.wait(until.urlContains('/users/?department=' + departmentId), 2000);
    var url = new URL(await driver.getCurrentUrl());
    assert.strictEqual(url.pathname, '/users/');
    assert.strictEqual(url.searchParams.get('department'), departmentId);
  });

  it('opens and closes the existing secondary-supervisor modal with real pointer input', async function () {
    await setViewport(driver, 1200, 850);
    await openDepartment();
    var trigger = await driver.findElement(By.css('a[data-vpp-add-new-secondary-supervisor="1"]'));
    await trigger.click();
    var modal = await driver.findElement(By.css('#add_secondary_supervisers_modal'));
    await driver.wait(until.elementIsVisible(modal), 2000);
    await driver.wait(until.elementLocated(By.css(
      '#add_secondary_supervisers_modal [data-vpp-add-supervisor-modal-add-new-user="1"]'
    )), 2500);
    assert.strictEqual(await modal.getAttribute('aria-labelledby'), 'add_secondary_supervisers_modal_label');
    await modal.findElement(By.css('[data-dismiss="modal"]')).click();
    await driver.wait(until.elementIsNotVisible(modal), 1800);
  });

  it('mobile navigation, actions, controls and checkbox labels meet the touch contract', async function () {
    await setViewport(driver, 390, 844);
    await openDepartment();
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
      var nav = rect('.department-details-nav .list-group-item');
      return {
        nav: nav,
        navSameRow: Math.abs(
          document.querySelectorAll('.department-details-nav .list-group-item')[0].getBoundingClientRect().top -
          document.querySelectorAll('.department-details-nav .list-group-item')[1].getBoundingClientRect().top
        ) <= 1,
        actions: rect('.department-details-actions .btn, .department-details-danger-action .btn, .department-supervisors-heading .btn'),
        controls: rect('.department-details-page .form-control'),
        choices: rect('.department-choice-label'),
        policyColumns: getComputedStyle(document.querySelector('.department-details-policy-grid')).gridTemplateColumns.split(' ').length
      };
    });
    assert.strictEqual(result.nav.length, 2);
    assert.strictEqual(result.navSameRow, true, 'mobile nav should be a 1x2 grid');
    assert.strictEqual(result.policyColumns, 1, 'mobile policy layout should be one column');
    var targets = result.nav.concat(result.actions, result.choices);
    assert(targets.length >= 7, 'touch target check is vacuous');
    targets.forEach(function (target) {
      assert(target.width >= 44 && target.height >= 44, 'target <44px: ' + JSON.stringify(target));
    });
    assert(result.controls.length >= 4, 'form control check is vacuous');
    result.controls.forEach(function (control) {
      assert(control.height >= 44, 'control <44px: ' + JSON.stringify(control));
    });
  });

  it('mobile Tab walk reaches navigation, form regions and exits with visible focus', async function () {
    await setViewport(driver, 390, 844);
    await openDepartment();
    await driver.executeScript('document.body.focus()');
    var entered = false;
    var left = false;
    var ring = false;
    var reached = {};
    var sequence = [];
    for (var index = 0; index < 80; index++) {
      await driver.actions().sendKeys(Key.TAB).perform();
      var state = await driver.executeScript(function () {
        var element = document.activeElement;
        if (!element || element === document.body) return null;
        var style = getComputedStyle(element);
        return {
          inPage: !!(element.closest && element.closest('.department-details-page')),
          visible: element.offsetWidth > 0 && element.offsetHeight > 0 &&
            style.visibility !== 'hidden' && style.display !== 'none',
          ring: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
          id: element.id || element.name || element.tagName,
          nav: !!(element.closest && element.closest('.department-details-nav')),
          supervisor: element.matches && element.matches('[data-vpp-add-new-secondary-supervisor]'),
          choice: element.id === 'use_bank_holidays_inp' || element.id === 'is_accrued_allowance_inp',
          action: element.id === 'save_changes_btn' || element.id === 'remove_btn'
        };
      });
      if (!state) continue;
      sequence.push(state.id);
      if (state.inPage) {
        entered = true;
        assert(state.visible, 'hidden focus target: ' + JSON.stringify(state));
        ring = ring || state.ring;
        if (state.nav) reached.nav = true;
        if (state.id === 'name' || state.id === 'manager_id') reached.core = true;
        if (state.supervisor) reached.supervisor = true;
        if (state.choice) reached.choice = true;
        if (state.action) reached.action = true;
      } else if (entered) {
        left = true;
        break;
      }
    }
    assert(ring, 'no visible focus ring');
    assert.deepStrictEqual(reached, {
      nav: true, core: true, supervisor: true, choice: true, action: true
    }, 'Tab missed a region: ' + sequence.join(' -> '));
    assert(left, 'Tab did not leave the page');
  });

  it('mobile EN/RU/KK text and controls remain within the workspace and viewport', async function () {
    var locales = ['en', 'ru', 'kk'];
    for (var index = 0; index < locales.length; index++) {
      await open_page_func({ url: applicationHost + 'language/' + locales[index], driver: driver });
      await setViewport(driver, 390, 844);
      await openDepartment();
      await assertMobileGeometry(driver, locales[index]);
    }
  });

  it('light and dark primary, secondary and navigation text meet WCAG AA', async function () {
    var themes = ['light', 'dark'];
    for (var themeIndex = 0; themeIndex < themes.length; themeIndex++) {
      await setViewport(driver, 1200, 850);
      await openDepartment();
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
        var elements = document.querySelectorAll(
          '.department-details-surface h2, .department-details-surface h3, .department-details-surface .help-block, .department-details-nav .list-group-item'
        );
        return Array.prototype.map.call(elements, function (element) {
          var backgroundElement = element.closest('.department-details-nav') ? element : element.closest('.surface');
          return {
            text: element.textContent.trim().slice(0, 45),
            ratio: ratio(getComputedStyle(element).color, getComputedStyle(backgroundElement).backgroundColor)
          };
        }).filter(function (item) { return item.text; });
      });
      assert(results.length >= 7, themes[themeIndex] + ' contrast probe is vacuous');
      results.forEach(function (result) {
        assert(result.ratio >= 4.5,
          themes[themeIndex] + ' contrast <4.5: ' + JSON.stringify(result));
      });
    }
  });

  it('CDP reduced motion neutralizes transitions and compound press transforms', async function () {
    await setViewport(driver, 1200, 850);
    await openDepartment();
    await setReducedMotion(driver, true);
    var result = await driver.executeScript(function () {
      var button = document.querySelector('.department-details-actions .btn');
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        transition: getComputedStyle(button).transitionDuration,
        rule: Array.prototype.some.call(document.styleSheets, function (sheet) {
          var rules;
          try { rules = sheet.cssRules; } catch (error) { return false; }
          return Array.prototype.some.call(rules, function (candidate) {
            return candidate.conditionText &&
              candidate.conditionText.indexOf('prefers-reduced-motion') > -1 &&
              candidate.cssText.indexOf('.department-details-page') > -1 &&
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
      await openDepartment();
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
    await shot('desktop-light-policy', 1440, 900, 'light', '.department-details-policy-grid');
    await shot('desktop-light-supervisors', 1440, 900, 'light', '.department-supervisors-field');
    await shot('desktop-dark-top', 1440, 900, 'dark', 'top');
    await shot('desktop-dark-policy', 1440, 900, 'dark', '.department-details-policy-grid');
    await shot('desktop-dark-supervisors', 1440, 900, 'dark', '.department-supervisors-field');
    await shot('mobile-light-top', 390, 844, 'light', 'top');
    await shot('mobile-light-policy', 390, 844, 'light', '.department-details-policy-grid');
    await shot('mobile-dark-top', 390, 844, 'dark', 'top');
    await shot('mobile-dark-policy', 390, 844, 'dark', '.department-details-policy-grid');
    await open_page_func({ url: applicationHost + 'language/ru', driver: driver });
    await shot('mobile-ru-light', 390, 844, 'light', '.department-supervisors-field');
    await open_page_func({ url: applicationHost + 'language/kk', driver: driver });
    await shot('mobile-kk-dark', 390, 844, 'dark', '.department-details-policy-grid');

    assert.strictEqual(
      fs.readdirSync(SCREEN_DIR).filter(function (name) { return /\.png$/.test(name); }).length,
      12
    );
  });
});
