'use strict';

/* globals describe, it, before, after */

/*
 * Stage 8F — runtime contract for /settings/general/.
 *
 * Exercises the rendered workspace without submitting carry-over, leave-type
 * deletion or company deletion. Screenshots are test artifacts under /tmp.
 */

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

var SCREEN_DIR = '/tmp/stage8f-general-settings';

function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) {
    fs.mkdirSync(SCREEN_DIR, { recursive: true });
  }
}

async function setViewport(driver, width, height) {
  await driver.manage().window().setRect({ width: width, height: height });
  await driver.sleep(180);
}

async function openSettings(driver, host) {
  await open_page_func({ url: host + 'settings/general/', driver: driver });
  await driver.wait(until.elementLocated(By.css('.general-settings-page')), 2500);
}

async function capture(driver, name) {
  ensureScreenDir();
  var image = await driver.takeScreenshot();
  var file = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(file, image, 'base64');
  assert(fs.statSync(file).size > 0, 'screenshot must be non-empty: ' + file);
}

async function collapseMobileNav(driver) {
  var toggles = await driver.findElements(By.css('.navbar-toggle'));
  if (!toggles.length || !(await toggles[0].isDisplayed())) return;
  var expanded = await driver.executeScript(function () {
    var collapse = document.querySelector('.navbar-collapse');
    return !!(collapse && getComputedStyle(collapse).display !== 'none');
  });
  if (expanded) {
    // Screenshot setup only: ask the already-loaded Bootstrap controller to close the
    // global nav, then wait for its short collapse transition. Interaction contracts
    // elsewhere continue to use real Selenium clicks/keys.
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

var MOBILE_GEOMETRY_SCRIPT = function () {
  var page = document.querySelector('.general-settings-page');
  var de = document.documentElement;
  var tolerance = 1;
  var findings = [];
  var ranges = 0;
  var boxes = 0;

  function rounded(value) {
    return Math.round(value * 10) / 10;
  }

  function record(kind, side, value, limit, where) {
    findings.push({
      kind: kind,
      side: side,
      value: rounded(value),
      limit: rounded(limit),
      where: where
    });
  }

  function isHidden(element) {
    if (!element) return true;
    if (element.closest('.sr-only, [aria-hidden="true"]')) return true;
    var style = getComputedStyle(element);
    return style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0;
  }

  function inspectBlock(block, label) {
    if (isHidden(block)) return;
    var boundary = block.getBoundingClientRect();
    if (block.scrollWidth > block.clientWidth + 2) {
      record('scroll', 'scrollWidth', block.scrollWidth, block.clientWidth, label);
    }
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (!(node.nodeValue || '').trim() || isHidden(node.parentElement)) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var index = 0; index < rects.length; index++) {
        var rect = rects[index];
        if (rect.width <= 0 || rect.height <= 0) continue;
        ranges++;
        if (rect.left < boundary.left - tolerance) {
          record('text', 'left<block', rect.left, boundary.left, label);
        }
        if (rect.right > boundary.right + tolerance) {
          record('text', 'right>block', rect.right, boundary.right, label);
        }
        if (rect.left < -tolerance) record('text', 'left<viewport', rect.left, 0, label);
        if (rect.right > window.innerWidth + tolerance) {
          record('text', 'right>viewport', rect.right, window.innerWidth, label);
        }
      }
    }

    var children = block.querySelectorAll(
      'input:not([type="hidden"]), select, button, a, label, .input-group'
    );
    for (var childIndex = 0; childIndex < children.length; childIndex++) {
      var child = children[childIndex];
      if (isHidden(child)) continue;
      var box = child.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      boxes++;
      if (box.left < boundary.left - tolerance) {
        record('element', 'left<block', box.left, boundary.left, label + ':' + child.tagName);
      }
      if (box.right > boundary.right + tolerance) {
        record('element', 'right>block', box.right, boundary.right, label + ':' + child.tagName);
      }
      if (box.left < -tolerance) {
        record('element', 'left<viewport', box.left, 0, label + ':' + child.tagName);
      }
      if (box.right > window.innerWidth + tolerance) {
        record('element', 'right>viewport', box.right, window.innerWidth, label + ':' + child.tagName);
      }
    }
  }

  var surfaces = page.querySelectorAll('.surface');
  for (var surfaceIndex = 0; surfaceIndex < surfaces.length; surfaceIndex++) {
    inspectBlock(surfaces[surfaceIndex], 'surface-' + surfaceIndex);
  }
  var rows = page.querySelectorAll('.leave-types-row');
  for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    inspectBlock(rows[rowIndex], 'leave-type-' + rowIndex);
  }

  return {
    ranges: ranges,
    boxes: boxes,
    findings: findings,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    innerWidth: window.innerWidth,
    surfaces: surfaces.length,
    leaveRows: rows.length
  };
};

async function assertMobileGeometry(driver, locale) {
  await driver.sleep(220);
  var geometry = await driver.executeScript(MOBILE_GEOMETRY_SCRIPT);
  var prefix = '[' + locale + '] ';
  assert(geometry.surfaces === 6,
    prefix + 'expected 6 surfaces, got ' + geometry.surfaces);
  assert(geometry.leaveRows > 0,
    prefix + 'expected non-vacuous leave-type rows');
  assert(geometry.ranges > 0 && geometry.boxes > 0,
    prefix + 'geometry probe is degenerate: ' + JSON.stringify(geometry));
  assert(geometry.scrollWidth <= geometry.clientWidth + 1,
    prefix + 'document overflow: ' + geometry.scrollWidth + ' > ' + geometry.clientWidth);
  assert(geometry.scrollWidth <= geometry.innerWidth + 1,
    prefix + 'viewport overflow: ' + geometry.scrollWidth + ' > ' + geometry.innerWidth);
  assert.strictEqual(
    geometry.findings.length,
    0,
    prefix + 'geometry violations: ' + JSON.stringify(geometry.findings.slice(0, 20))
  );
}

describe('General Settings interaction, geometry and visual matrix (Stage 8F)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var applicationHost = config.get_application_host();

  before(function (done) {
    register_new_user_func({ application_host: applicationHost }).then(function (data) {
      driver = data.driver;
      done();
    }, done);
  });

  after(async function () {
    if (driver) await driver.quit();
  });

  it('renders one heading, six surfaces and every protected form endpoint', async function () {
    await setViewport(driver, 1440, 900);
    await openSettings(driver, applicationHost);

    assert.strictEqual((await driver.findElements(By.css('main h1'))).length, 1);
    assert.strictEqual((await driver.findElements(By.css('.general-settings-page .surface'))).length, 6);

    var contracts = await driver.executeScript(function () {
      function form(id) {
        var element = document.getElementById(id);
        return element && {
          method: element.method.toLowerCase(),
          path: new URL(element.action).pathname
        };
      }
      return {
        company: form('company_edit_form'),
        schedule: form('company_schedule_form'),
        carry: form('calculate_carry_over_form'),
        deleteLeave: form('delete_leavetype_form'),
        editLeave: form('leave_type_edit_form'),
        companyWide: document.querySelector(
          '#company_schedule_form input[name="company_wide"]'
        ).value,
        rows: document.querySelectorAll('.leave-types-row').length
      };
    });

    assert.deepStrictEqual(contracts.company, { method: 'post', path: '/settings/company/' });
    assert.deepStrictEqual(contracts.schedule, { method: 'post', path: '/settings/schedule' });
    assert.deepStrictEqual(contracts.carry, {
      method: 'post',
      path: '/settings/carryOverUnusedAllowance'
    });
    assert.deepStrictEqual(contracts.deleteLeave, {
      method: 'post',
      path: '/settings/leavetypes/delete/'
    });
    assert.deepStrictEqual(contracts.editLeave, {
      method: 'post',
      path: '/settings/leavetypes/'
    });
    assert.strictEqual(contracts.companyWide, '1');
    assert(contracts.rows > 0, 'leave type editor must render non-vacuously');
  });

  it('desktop layout has a two-column workspace and aligned leave-type editor', async function () {
    await setViewport(driver, 1440, 900);
    await openSettings(driver, applicationHost);
    var layout = await driver.executeScript(function () {
      var workspace = document.querySelector('.general-settings-workspace');
      var company = document.querySelector('.general-settings-company').getBoundingClientRect();
      var operations = document.querySelector('.general-settings-operations').getBoundingClientRect();
      var row = document.querySelector('.leave-types-row');
      return {
        columns: getComputedStyle(workspace).gridTemplateColumns.split(' ').length,
        sameTop: Math.abs(company.top - operations.top) <= 1,
        rowColumns: getComputedStyle(row).gridTemplateColumns.split(' ').length,
        documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      };
    });
    assert.strictEqual(layout.columns, 2, 'workspace must be two columns on desktop');
    assert.strictEqual(layout.sameTop, true, 'company and operations should begin on the same row');
    assert.strictEqual(layout.rowColumns, 6, 'leave editor must expose six aligned desktop columns');
    assert(layout.documentWidth <= layout.clientWidth + 1, 'desktop must not overflow horizontally');
  });

  it('opens color picker and both modals without submitting destructive actions', async function () {
    await setViewport(driver, 1200, 850);
    await openSettings(driver, applicationHost);

    var picker = await driver.findElement(By.css(
      '#leave_type_edit_form [data-tom-color-picker="1"] .dropdown-toggle'
    ));
    await picker.click();
    await driver.wait(until.elementIsVisible(
      driver.findElement(By.css('#leave_type_edit_form .color-picker-menu'))
    ), 1500);
    await driver.actions().sendKeys(Key.ESCAPE).perform();

    await driver.findElement(By.css('#add_new_leave_type_btn')).click();
    await driver.wait(until.elementIsVisible(
      driver.findElement(By.css('#add_new_leave_type_modal'))
    ), 1500);
    await driver.findElement(By.css(
      '#add_new_leave_type_modal .modal-footer [data-dismiss="modal"]'
    )).click();
    await driver.wait(until.elementIsNotVisible(
      driver.findElement(By.css('#add_new_leave_type_modal'))
    ), 1500);
    await driver.wait(async function () {
      return (await driver.findElements(By.css('.modal-backdrop'))).length === 0;
    }, 1500);

    var dangerTrigger = await driver.findElement(By.css(
      '.general-settings-danger [data-target="#remove_company_modal"]'
    ));
    await driver.executeScript(
      'arguments[0].scrollIntoView({block:"center"})',
      dangerTrigger
    );
    await dangerTrigger.click();
    await driver.wait(until.elementIsVisible(
      driver.findElement(By.css('#remove_company_modal'))
    ), 1500);
    await driver.findElement(By.css(
      '#remove_company_modal .modal-footer [data-dismiss="modal"]'
    )).click();
    await driver.wait(until.elementIsNotVisible(
      driver.findElement(By.css('#remove_company_modal'))
    ), 1500);
  });

  it('mobile actions meet 44px and leave types become one-column cards', async function () {
    await setViewport(driver, 390, 844);
    await openSettings(driver, applicationHost);
    var result = await driver.executeScript(function () {
      var row = document.querySelector('.leave-types-row');
      var selectors = [
        '.settings-actions .btn',
        '.settings-related-item > .btn',
        '.settings-danger-content > .btn',
        '.leave-types-remove-cell .btn',
        '.settings-schedule-widget .btn',
        '.leave-types-name-cell .input-group-addon'
      ];
      var targets = document.querySelectorAll(selectors.join(','));
      var rects = Array.prototype.map.call(targets, function (element) {
        var rect = element.getBoundingClientRect();
        return {
          label: element.id || element.textContent.trim().slice(0, 30),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      });
      var controls = Array.prototype.map.call(
        document.querySelectorAll('.general-settings-page .form-control'),
        function (element) {
          var rect = element.getBoundingClientRect();
          return {
            name: element.name || element.id,
            height: Math.round(rect.height),
            visible: element.offsetWidth > 0 && element.offsetHeight > 0
          };
        }
      ).filter(function (control) { return control.visible; });
      return {
        rowColumns: getComputedStyle(row).gridTemplateColumns.split(' ').length,
        rects: rects,
        controls: controls
      };
    });
    assert.strictEqual(result.rowColumns, 1, 'mobile leave type must be a one-column card');
    assert(result.rects.length > 10, 'tap-target test must be non-vacuous');
    for (var index = 0; index < result.rects.length; index++) {
      assert(result.rects[index].width >= 44 && result.rects[index].height >= 44,
        'target <44px: ' + JSON.stringify(result.rects[index]));
    }
    assert(result.controls.length > 10, 'form-control target test must be non-vacuous');
    for (var controlIndex = 0; controlIndex < result.controls.length; controlIndex++) {
      assert(result.controls[controlIndex].height >= 44,
        'form control <44px high: ' + JSON.stringify(result.controls[controlIndex]));
    }
  });

  it('mobile Tab walk reaches all regions, shows focus and leaves the page', async function () {
    await setViewport(driver, 390, 844);
    await openSettings(driver, applicationHost);
    await driver.executeScript('document.body.focus()');

    var entered = false;
    var left = false;
    var ring = false;
    var reached = {};
    var sequence = [];
    for (var index = 0; index < 120; index++) {
      await driver.actions().sendKeys(Key.TAB).perform();
      var state = await driver.executeScript(function () {
        var element = document.activeElement;
        if (!element || element === document.body) return null;
        var style = getComputedStyle(element);
        var section = element.closest && element.closest('.surface');
        return {
          inPage: !!(element.closest && element.closest('.general-settings-page')),
          visible: element.offsetWidth > 0 && element.offsetHeight > 0 &&
            style.visibility !== 'hidden' && style.display !== 'none',
          ring: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
          section: section ? section.className : '',
          id: element.id || element.name || element.tagName
        };
      });
      if (!state) continue;
      sequence.push(state.id);
      if (state.inPage) {
        entered = true;
        assert(state.visible, 'hidden focus target: ' + JSON.stringify(state));
        ring = ring || state.ring;
        if (state.section.indexOf('general-settings-company') > -1) reached.company = true;
        if (state.section.indexOf('general-settings-schedule') > -1) reached.schedule = true;
        if (state.section.indexOf('general-settings-carry-over') > -1) reached.carry = true;
        if (state.section.indexOf('general-settings-leave-types') > -1) reached.leave = true;
        if (state.section.indexOf('general-settings-related') > -1) reached.related = true;
        if (state.section.indexOf('general-settings-danger') > -1) reached.danger = true;
      } else if (entered) {
        left = true;
        break;
      }
    }
    assert(ring, 'no visible focus ring during Tab walk');
    assert.deepStrictEqual(reached, {
      company: true,
      schedule: true,
      carry: true,
      leave: true,
      related: true,
      danger: true
    }, 'Tab did not reach every region: ' + sequence.join(' -> '));
    assert(left, 'Tab walk did not leave the page');
  });

  it('mobile EN/RU/KK text and controls remain inside cards and viewport', async function () {
    var locales = ['en', 'ru', 'kk'];
    for (var index = 0; index < locales.length; index++) {
      await open_page_func({
        url: applicationHost + 'language/' + locales[index],
        driver: driver
      });
      await setViewport(driver, 390, 844);
      await openSettings(driver, applicationHost);
      await assertMobileGeometry(driver, locales[index]);
    }
  });

  it('light and dark surface text meet AA contrast', async function () {
    var themes = ['light', 'dark'];
    for (var index = 0; index < themes.length; index++) {
      await setViewport(driver, 1200, 850);
      await openSettings(driver, applicationHost);
      await setTheme(driver, themes[index]);
      var contrast = await driver.executeScript(function () {
        function rgba(value) {
          var match = value.match(/[\d.]+/g).map(Number);
          return match.slice(0, 3);
        }
        function channel(value) {
          value /= 255;
          return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
        }
        function luminance(rgb) {
          return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
        }
        function ratio(foreground, background) {
          var first = luminance(rgba(foreground));
          var second = luminance(rgba(background));
          return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
        }
        var results = [];
        var elements = document.querySelectorAll(
          '.surface h2, .surface h3, .surface .settings-help, .settings-danger-warning'
        );
        for (var elementIndex = 0; elementIndex < elements.length; elementIndex++) {
          var element = elements[elementIndex];
          if (!element.offsetWidth || !element.offsetHeight) continue;
          var surface = element.closest('.surface');
          results.push({
            text: element.textContent.trim().slice(0, 40),
            ratio: ratio(
              getComputedStyle(element).color,
              getComputedStyle(surface).backgroundColor
            )
          });
        }
        return results;
      });
      assert(contrast.length > 10, themes[index] + ' contrast test is vacuous');
      for (var resultIndex = 0; resultIndex < contrast.length; resultIndex++) {
        assert(contrast[resultIndex].ratio >= 4.5,
          themes[index] + ' contrast <4.5: ' + JSON.stringify(contrast[resultIndex]));
      }
    }
  });

  it('CDP reduced motion neutralizes the compound press transform', async function () {
    await setViewport(driver, 1200, 850);
    await openSettings(driver, applicationHost);
    await setReducedMotion(driver, true);
    var result = await driver.executeScript(function () {
      var button = document.querySelector('.settings-actions .btn');
      button.classList.add('stage8f-force-active');
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        transition: getComputedStyle(button).transitionDuration
      };
    });
    assert.strictEqual(result.matches, true, 'reduced-motion media emulation did not apply');
    assert(/(^|, )0s/.test(result.transition),
      'transition should be neutralized under reduced motion: ' + result.transition);

    var stylesheetContract = await driver.executeScript(function () {
      var found = false;
      for (var sheetIndex = 0; sheetIndex < document.styleSheets.length; sheetIndex++) {
        var rules;
        try { rules = document.styleSheets[sheetIndex].cssRules; } catch (error) { continue; }
        for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
          var rule = rules[ruleIndex];
          if (rule.conditionText &&
              rule.conditionText.indexOf('prefers-reduced-motion') > -1 &&
              rule.cssText.indexOf('.general-settings-page') > -1 &&
              rule.cssText.indexOf(':hover:active') > -1 &&
              rule.cssText.indexOf('transform: none') > -1) {
            found = true;
          }
        }
      }
      return found;
    });
    assert.strictEqual(stylesheetContract, true,
      'reduced-motion rule must cover :hover:active with transform:none');
    await setReducedMotion(driver, false);
  });

  it('captures the 12-frame visual matrix in /tmp', async function () {
    async function shot(name, width, height, theme, selector) {
      await setViewport(driver, width, height);
      await openSettings(driver, applicationHost);
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
    await shot('desktop-light-leave-types', 1440, 900, 'light', '.general-settings-leave-types');
    await shot('desktop-light-danger', 1440, 900, 'light', '.general-settings-danger');
    await shot('desktop-dark-top', 1440, 900, 'dark', 'top');
    await shot('desktop-dark-leave-types', 1440, 900, 'dark', '.general-settings-leave-types');
    await shot('desktop-dark-danger', 1440, 900, 'dark', '.general-settings-danger');
    await shot('mobile-light-top', 390, 844, 'light', 'top');
    await shot('mobile-light-leave-types', 390, 844, 'light', '.general-settings-leave-types');
    await shot('mobile-dark-top', 390, 844, 'dark', 'top');
    await shot('mobile-dark-leave-types', 390, 844, 'dark', '.general-settings-leave-types');

    await open_page_func({ url: applicationHost + 'language/ru', driver: driver });
    await shot('mobile-ru-light', 390, 844, 'light', '.general-settings-leave-types');
    await open_page_func({ url: applicationHost + 'language/kk', driver: driver });
    await shot('mobile-kk-dark', 390, 844, 'dark', '.general-settings-leave-types');

    assert.strictEqual(
      fs.readdirSync(SCREEN_DIR).filter(function (name) { return /\.png$/.test(name); }).length,
      12,
      'expected exactly 12 screenshots'
    );
  });

  it('creates a leave type through the existing modal and renders success feedback', async function () {
    await open_page_func({ url: applicationHost + 'language/en', driver: driver });
    await setViewport(driver, 1200, 850);
    await openSettings(driver, applicationHost);

    await driver.findElement(By.css('#add_new_leave_type_btn')).click();
    var modal = await driver.findElement(By.css('#add_new_leave_type_modal'));
    await driver.wait(until.elementIsVisible(modal), 1500);
    await driver.wait(function () {
      return driver.executeScript(function () {
        var element = document.querySelector('#add_new_leave_type_modal');
        var dialog = element && element.querySelector('.modal-dialog');
        if (!element || !dialog || !element.classList.contains('in')) return false;
        var transform = getComputedStyle(dialog).transform;
        return getComputedStyle(element).opacity === '1' &&
          (transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)');
      });
    }, 1500);
    var name = 'Stage 8F runtime type';
    var nameInput = await modal.findElement(By.css('input[name="name__new"]'));
    await nameInput.sendKeys(name);
    await modal.findElement(By.css('button[type="submit"]')).click();

    await driver.wait(until.elementLocated(By.css('.general-settings-page .alert-success')), 2500);
    var message = await driver.findElement(By.css(
      '.general-settings-page .alert-success'
    )).getText();
    assert(/Changes to leave types were saved/.test(message),
      'expected leave-type success feedback, got: ' + message);
    var values = await driver.findElements(By.css(
      '#leave_type_edit_form input[name^="name__"]'
    ));
    var names = [];
    for (var index = 0; index < values.length; index++) {
      names.push(await values[index].getAttribute('value'));
    }
    assert(names.indexOf(name) > -1, 'created leave type must render in the editor');
  });
});
