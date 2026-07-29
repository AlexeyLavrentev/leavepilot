'use strict';

/* globals describe, it, before, after */

/*
 * Stage 8C — Selenium contract: Departments overview interaction + geometry +
 * the CRITICAL mobile Tab-a11y assertion + visual matrix.
 *
 * Mirrors the Stage 8B v2 patterns established in
 * t/integration/reports_hub/reports_hub_contract.js (real Tab, real pointer
 * click, CDP-emulated reduced-motion, RU geometry) and adds the highest-value
 * assertion: at <=768px the two header help-buttons are display:none
 * (via .policy-help-desktop), so Tab must NOT land on them. Proven with a real
 * Tab loop that is capable of failing if display:none were removed, and that
 * also reaches a real row link so the loop is not vacuous.
 */

var path   = require('path'),
    fs     = require('fs'),
    assert = require('assert'),
    webdriver = require('selenium-webdriver'),
    By     = webdriver.By,
    until  = webdriver.until,
    Key    = webdriver.Key,
    config = require('../../lib/config'),
    register_new_user_func = require('../../lib/register_new_user'),
    open_page_func = require('../../lib/open_page'),
    submit_form_func = require('../../lib/submit_form');

var SCREEN_DIR = '/tmp/screens';
var NEW_DEPARTMENT_FORM_ID = '#add_new_department_form';

function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) {
    fs.mkdirSync(SCREEN_DIR, { recursive: true });
  }
}

async function setViewport(driver, w, h) {
  await driver.manage().window().setRect({ width: w, height: h });
  await driver.sleep(250);
}

async function capture(driver, name) {
  ensureScreenDir();
  var image = await driver.takeScreenshot();
  var file = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(file, image, 'base64');
  assert(fs.statSync(file).size > 0, 'screenshot must be non-empty: ' + file);
  return file;
}

// Open the Bootstrap theme dropdown via its real toggle (the <a> inside #theme-menu).
// On collapsed navbars (mobile), expand .navbar-toggle first so the menu is interactable,
// then collapse it again afterwards for a clean screenshot.
async function setTheme(driver, theme /* 'light' | 'dark' */) {
  var navbarNeedsExpand = await driver.executeScript(
    'var t=document.querySelector(".navbar-toggle");' +
    'return !!(t && getComputedStyle(t).display!=="none" && t.offsetWidth>0);'
  );
  if (navbarNeedsExpand) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(300);
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.wait(until.elementLocated(By.css('[data-theme-value="' + theme + '"]')), 1000);
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(150);
  if (theme === 'dark') {
    await driver.wait(until.elementLocated(By.css('html[data-theme="dark"]')), 2000);
  } else {
    await driver.wait(function () {
      return driver.executeScript('return document.documentElement.getAttribute("data-theme") === null;');
    }, 2000);
  }
  if (navbarNeedsExpand) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(200);
  }
}

// Toggle prefers-reduced-motion via the Chrome DevTools Protocol. selenium-webdriver 4.45
// exposes the chromedriver CDP bridge through driver.sendDevToolsCommand(cmd, params).
// The modern DevTools method is Emulation.setEmulatedMedia with a `features` array.
// Pass value '' to clear.
async function setReducedMotion(driver, enabled /* true | false */) {
  await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: enabled ? 'reduce' : '' }]
  });
  await driver.sleep(80);
}

async function openDepartments(driver, application_host) {
  await open_page_func({ url: application_host + 'settings/departments/', driver: driver });
  await driver.wait(until.elementLocated(By.css('.departments-page')), 2000);
}

// Add one department via the #add_new_department_modal form. The default company
// already ships with one ("Sales"); this is used to guarantee >=1 row AND to add a
// second so mobile stacking geometry is non-trivial.
async function addDepartment(driver, name, allowance) {
  await driver.findElement(By.css('#add_new_department_btn')).click();
  // Bootstrap modal animation — required wait, see t/integration/department/one_by_one_crud.js.
  await driver.sleep(1000);
  await submit_form_func({
    driver: driver,
    form_params: [
      { selector: NEW_DEPARTMENT_FORM_ID + ' input[name="name__new"]', value: name },
      {
        selector: NEW_DEPARTMENT_FORM_ID + ' select[name="allowance__new"]',
        option_selector: 'option[value="' + allowance + '"]',
        value: allowance
      }
    ],
    submit_button_selector: NEW_DEPARTMENT_FORM_ID + ' button[type="submit"]',
    message: /Changes to departments were saved/
  });
}

describe('Departments overview interaction, mobile Tab a11y, geometry & visual matrix (Stage 8C)', function () {

  this.timeout(config.get_execution_timeout());

  var driver;
  var application_host = config.get_application_host();

  before(function (done) {
    register_new_user_func({ application_host: application_host }).then(function (data) {
      driver = data.driver;
      done();
    }, done);
  });

  after(function () {
    return driver.quit();
  });

  // Setup: ensure at least one department row exists. The default company ships with
  // one ("Sales"), but we verify and add if empty. We also add a second so the mobile
  // stacking geometry assertion is non-vacuous (>=2 rows to confirm a single column).
  it('setup: guarantees >=2 department rows on /settings/departments/', async function () {
    await openDepartments(driver, application_host);
    var initialRows = await driver.findElements(
      By.css('tr[data-vpp-department-list-mode="readonly"]')
    );
    if (initialRows.length === 0) {
      await addDepartment(driver, 'Setup Department', '15');
      await openDepartments(driver, application_host);
    }
    // Add a second distinct department so stacking geometry has >=2 rows.
    await addDepartment(driver, 'Stage8C Test Department', '20');
    await openDepartments(driver, application_host);
    var rows = await driver.findElements(
      By.css('tr[data-vpp-department-list-mode="readonly"]')
    );
    assert(rows.length >= 2, 'expected >=2 department rows after setup, got ' + rows.length);
  });

  it('renders the scoped page: .departments-page, .departments-catalog.surface, >=1 row', async function () {
    await openDepartments(driver, application_host);
    await driver.findElement(By.css('.departments-page'));
    await driver.findElement(By.css('.departments-catalog.surface'));
    var rows = await driver.findElements(
      By.css('tr[data-vpp-department-list-mode="readonly"]')
    );
    assert(rows.length >= 1, 'expected >=1 department row, got ' + rows.length);
  });

  // Tap-target sizing. NOTE: the Stage 8C redesign deliberately keeps the add-department
  // The action button and the header help-buttons must meet the 44px tap-target
  // guidance (WCAG 2.5.5) without breaking table density — they sit in the page
  // header / column header, not in data rows, so a min-height:44px on each is safe.
  it('action + header help buttons meet the 44px tap-target guidance', async function () {
    await setViewport(driver, 1440, 900);
    await openDepartments(driver, application_host);
    var addBtn = await driver.findElement(By.css('#add_new_department_btn'));
    var addRect = await driver.executeScript(
      'var b=arguments[0].getBoundingClientRect(); return {w:b.width,h:b.height};',
      addBtn
    );
    assert(addRect.h >= 44 && addRect.w >= 44,
      '#add_new_department_btn must be >=44px on both axes, got ' + JSON.stringify(addRect));

    var helpBtns = await driver.findElements(By.css('.policy-help-desktop button'));
    assert.strictEqual(helpBtns.length, 2, 'expected exactly two desktop help buttons');
    for (var i = 0; i < helpBtns.length; i++) {
      var r = await driver.executeScript(
        'var b=arguments[0].getBoundingClientRect(); return {w:b.width,h:b.height};',
        helpBtns[i]
      );
      assert(r.h >= 44 && r.w >= 44,
        'help button ' + i + ' must be >=44px on both axes, got ' + JSON.stringify(r));
    }
  });

  it('desktop: help buttons visible and retain popover/aria attributes', async function () {
    await setViewport(driver, 1440, 900);
    await openDepartments(driver, application_host);
    var checks = await driver.executeScript(function () {
      var btns = document.querySelectorAll('.policy-help-desktop button');
      return Array.prototype.map.call(btns, function (b) {
        var cs = getComputedStyle(b);
        return {
          display: cs.display,
          toggle: b.getAttribute('data-toggle'),
          trigger: b.getAttribute('data-trigger'),
          hasContent: !!b.getAttribute('data-content'),
          ariaLabel: b.getAttribute('aria-label')
        };
      });
    });
    assert.strictEqual(checks.length, 2, 'expected two desktop help buttons');
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i];
      assert(c.display !== 'none', 'help button ' + i + ' display===' + c.display + ' at 1440');
      assert.strictEqual(c.toggle, 'popover', 'help button ' + i + ' data-toggle=' + c.toggle);
      assert.strictEqual(c.trigger, 'focus hover', 'help button ' + i + ' data-trigger=' + c.trigger);
      assert(c.hasContent, 'help button ' + i + ' missing data-content');
      assert(c.ariaLabel && c.ariaLabel.length > 0, 'help button ' + i + ' missing aria-label');
    }
  });

  it('mobile wiring: .policy-help-desktop display:none, .policy-help-mobile visible (390)', async function () {
    await setViewport(driver, 390, 844);
    await openDepartments(driver, application_host);
    await driver.sleep(200);
    var g = await driver.executeScript(function () {
      var desk = document.querySelector('.policy-help-desktop');
      var mob = document.querySelector('.policy-help-mobile');
      return {
        desktopDisplay: desk ? getComputedStyle(desk).display : 'no-desktop',
        mobileDisplay: mob ? getComputedStyle(mob).display : 'no-mobile',
        innerWidth: window.innerWidth
      };
    });
    assert.strictEqual(g.desktopDisplay, 'none',
      '.policy-help-desktop must be display:none at 390, got ' + g.desktopDisplay);
    assert(g.mobileDisplay !== 'none',
      '.policy-help-mobile must be visible at 390, got ' + g.mobileDisplay);
  });

  // CRITICAL (H6) — Tab does NOT land on the hidden header popover buttons at 390px.
  // At <=768px .policy-help-desktop is display:none, which removes the popover buttons
  // from the a11y tree / Tab order entirely (unlike a sr-only clip, which would leave
  // them focusable-but-invisible). We prove it with a REAL Tab loop: focus body, send
  // real synthesized Tab keystrokes, read document.activeElement after each, and assert
  // it is never a [data-toggle="popover"] button. The loop must also reach a real
  // .departments-catalog a (a row link) so the assertion is not vacuous. If display:none
  // were removed, the popover button would be focused at some point and this fails.
  it('CRITICAL (H6): Tab does not land on hidden header popover buttons at 390px', async function () {
    await setViewport(driver, 390, 844);
    await openDepartments(driver, application_host);
    await driver.sleep(200);

    // First, sanity: the desktop popover buttons are truly hidden at this width.
    var desktopHidden = await driver.executeScript(function () {
      var btns = document.querySelectorAll('.policy-help-desktop button');
      return Array.prototype.map.call(btns, function (b) {
        return { display: getComputedStyle(b.closest('.policy-help-desktop')).display };
      });
    });
    for (var h = 0; h < desktopHidden.length; h++) {
      assert.strictEqual(desktopHidden[h].display, 'none',
        'precondition: .policy-help-desktop must be display:none at 390 (button ' + h + ' got ' + desktopHidden[h].display + ')');
    }

    // Focus <body> as a known, neutral starting point.
    await driver.executeScript('document.body.focus();');
    await driver.sleep(120);

    var sequence = [];
    var landedOnPopover = false;
    var reachedRowLink = false;
    var reachedRowLinkHref = null;
    var MAX_TABS = 40;

    for (var i = 0; i < MAX_TABS; i++) {
      // Real synthesized keyboard Tab — NOT executeScript(.focus()).
      await driver.actions().sendKeys(Key.TAB).perform();
      await driver.sleep(40);
      var info = await driver.executeScript(function () {
        var el = document.activeElement;
        if (!el) return null;
        var tag = el.tagName;
        var cls = el.className || '';
        var id = el.id || '';
        var href = el.getAttribute('href') || '';
        var toggle = el.getAttribute('data-toggle') || '';
        var inCatalog = !!(el.closest && el.closest('.departments-catalog'));
        var isRowLink = !!(inCatalog && tag === 'A');
        return {
          tag: tag, cls: String(cls), id: id, href: href,
          toggle: toggle, inCatalog: inCatalog, isRowLink: isRowLink
        };
      });
      if (!info) { sequence.push('(no activeElement)'); continue; }
      var label = info.tag + (info.id ? '#' + info.id : '') +
        (info.cls ? '.' + String(info.cls).split(/\s+/).slice(0, 2).join('.') : '') +
        (info.toggle ? '[' + info.toggle + ']' : '');
      sequence.push(label);
      if (info.toggle === 'popover') {
        landedOnPopover = true;
      }
      if (info.isRowLink) {
        reachedRowLink = true;
        reachedRowLinkHref = info.href;
      }
      // Once we have proven a row link is reachable and have scanned the header
      // region, we can stop early — but keep going until a row link is hit so the
      // positive side of the assertion is genuinely exercised.
      if (reachedRowLink) { break; }
    }

    assert(reachedRowLink,
      'Tab loop never reached a .departments-catalog row link (loop was vacuous). Sequence: ' +
      sequence.join(' -> '));
    assert(/\/(settings\/departments\/edit|users\/)/.test(reachedRowLinkHref || ''),
      'reached row link href unexpected: ' + reachedRowLinkHref);
    assert(!landedOnPopover,
      'FAIL: Tab landed on a [data-toggle="popover"] button at 390px — display:none was not ' +
      'honored. Focus sequence: ' + sequence.join(' -> '));
  });

  // Real pointer navigation — name link -> /settings/departments/edit/<id>/
  it('real pointer click on the name link navigates to the edit page', async function () {
    await setViewport(driver, 1440, 900);
    await openDepartments(driver, application_host);
    var nameLink = await driver.findElement(
      By.css('tr[data-vpp-department-list-mode="readonly"] .departments-name-cell a')
    );
    var href = await nameLink.getAttribute('href');
    // Real mouse click synthesized by the driver.
    await nameLink.click();
    await driver.wait(function () {
      return driver.getCurrentUrl().then(function (u) { return /\/settings\/departments\/edit\/\d+\/?(\?|$)/.test(u); });
    }, 5000);
    var landed = await driver.getCurrentUrl();
    var expectedId = (href.match(/edit\/(\d+)\//) || [])[1];
    assert(landed.indexOf('/settings/departments/edit/' + expectedId + '/') > -1,
      'name-link click did not reach edit page for id ' + expectedId + ' (got ' + landed + ')');
  });

  // Real pointer navigation — manager link -> /users/edit/<id>/
  it('real pointer click on the manager link navigates to the user edit page', async function () {
    await setViewport(driver, 1440, 900);
    await openDepartments(driver, application_host);
    var mgrLink = await driver.findElement(
      By.css('tr[data-vpp-department-list-mode="readonly"] .departments-secondary a[href*="/users/edit/"]')
    );
    var href = await mgrLink.getAttribute('href');
    await mgrLink.click();
    await driver.wait(function () {
      return driver.getCurrentUrl().then(function (u) { return /\/users\/edit\/\d+\/?(\?|$)/.test(u); });
    }, 5000);
    var landed = await driver.getCurrentUrl();
    var expectedId = (href.match(/users\/edit\/(\d+)\//) || [])[1];
    assert(landed.indexOf('/users/edit/' + expectedId + '/') > -1,
      'manager-link click did not reach user edit page for id ' + expectedId + ' (got ' + landed + ')');
  });

  // Real pointer navigation — count link -> /users/?department=<id>
  it('real pointer click on the count link navigates to the filtered employees page', async function () {
    await setViewport(driver, 1440, 900);
    await openDepartments(driver, application_host);
    var countLink = await driver.findElement(
      By.css('tr[data-vpp-department-list-mode="readonly"] .departments-num a')
    );
    var href = await countLink.getAttribute('href');
    await countLink.click();
    await driver.wait(function () {
      return driver.getCurrentUrl().then(function (u) {
        return /\/users\/\?department=\d+/.test(u);
      });
    }, 5000);
    var landed = await driver.getCurrentUrl();
    var expectedId = (href.match(/department=(\d+)/) || [])[1];
    assert(landed.indexOf('department=' + expectedId) > -1,
      'count-link click did not reach filtered employees page for id ' + expectedId + ' (got ' + landed + ')');
  });

  it('mobile (390px): no horizontal overflow; cell + link content within viewport; single-column cards', async function () {
    await setViewport(driver, 390, 844);
    await openDepartments(driver, application_host);
    await driver.sleep(300);
    var g = await driver.executeScript(function () {
      var de = document.documentElement;
      var rows = document.querySelectorAll('tr[data-vpp-department-list-mode="readonly"]');
      // Measure BOTH the td and the inner <a> for name + manager cells — clipping
      // can hide inside a td whose edge fits but whose link overflows the grid track.
      var nameCells = document.querySelectorAll('.departments-name-cell');
      var mgrCells = document.querySelectorAll('.departments-secondary');
      function maxLinkRight(cells) {
        var max = 0;
        for (var i = 0; i < cells.length; i++) {
          var a = cells[i].querySelector('a');
          if (a) { var r = a.getBoundingClientRect().right; if (r > max) max = r; }
        }
        return max;
      }
      function maxCellRight(cells) {
        var max = 0;
        for (var i = 0; i < cells.length; i++) {
          var r = cells[i].getBoundingClientRect().right; if (r > max) max = r;
        }
        return max;
      }
      var a = rows[0] ? rows[0].getBoundingClientRect() : null;
      var b = rows[1] ? rows[1].getBoundingClientRect() : null;
      var stacked = a && b ? (b.top > a.top) : null;
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        innerWidth: window.innerWidth,
        nameCellRight: maxCellRight(nameCells),
        nameLinkRight: maxLinkRight(nameCells),
        mgrLinkRight: maxLinkRight(mgrCells),
        rowCount: rows.length,
        stacked: stacked
      };
    });
    assert(g.rowCount >= 2, 'expected >=2 rows for stacking check, got ' + g.rowCount);
    assert(g.scrollWidth <= g.clientWidth + 1,
      'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
    assert(g.scrollWidth <= g.innerWidth + 1,
      'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > innerWidth=' + g.innerWidth);
    assert(g.nameCellRight <= g.innerWidth + 1,
      'name cell right edge (' + g.nameCellRight + ') exceeds viewport (' + g.innerWidth + ')');
    // inner link content must not overflow its cell or the viewport (clipping guard)
    assert(g.nameLinkRight <= g.nameCellRight + 1,
      'name link right (' + g.nameLinkRight + ') exceeds its cell right (' + g.nameCellRight + ') — link content overflows the grid track');
    assert(g.nameLinkRight <= g.innerWidth + 1,
      'name link right (' + g.nameLinkRight + ') exceeds viewport (' + g.innerWidth + ')');
    assert(g.mgrLinkRight <= g.innerWidth + 1,
      'manager link right (' + g.mgrLinkRight + ') exceeds viewport (' + g.innerWidth + ') — long manager name clipped/overflowing');
    assert(g.stacked === true,
      'mobile: rows should stack vertically (row2 below row1)');
  });

  // Reduced-motion via CDP. The departments transform is :active-gated
  // (scale(0.98) on a:hover:active and .btn:hover:active). To make the test capable of
  // observing a non-identity transform under default media AND its suppression under
  // reduce, we ENGAGE :active via actions().press({origin}) (pointer-down holds active)
  // and read the computed transform while the pointer is held.
  it('reduced-motion (CDP): emulated media suppresses the active transform to none', async function () {
    await setViewport(driver, 1440, 900);
    await openDepartments(driver, application_host);
    await driver.wait(
      until.elementLocated(By.css('tr[data-vpp-department-list-mode="readonly"] .departments-name-cell a')),
      3000
    );

    var link = await driver.findElement(
      By.css('tr[data-vpp-department-list-mode="readonly"] .departments-name-cell a')
    );

    // 1) Baseline: under default media, holding :active on the link yields scale(0.98),
    //    i.e. a non-identity transform.
    var actions = driver.actions({ async: true });
    await actions.move({ origin: link }).press().perform();
    await driver.sleep(150);
    var baseline = await driver.executeScript(
      'var el=arguments[0]; return {' +
      'transform:getComputedStyle(el).transform,' +
      'active:el.matches(":active"),' +
      'hover:el.matches(":hover")};',
      link
    );
    await driver.actions({ async: true }).release().perform();
    assert(baseline.active,
      'precondition: link should be :active under press, got :active=' + baseline.active +
      ' :hover=' + baseline.hover);
    assert(baseline.transform !== 'none' && baseline.transform !== 'matrix(1, 0, 0, 1, 0, 0)',
      'baseline: active link should have a non-identity transform under default media, got ' + baseline.transform);

    // 2) Emulate prefers-reduced-motion: reduce via CDP and prove it applied via matchMedia.
    await setReducedMotion(driver, true);
    var mqApplied = await driver.executeScript(
      'return window.matchMedia("(prefers-reduced-motion: reduce)").matches'
    );
    assert(mqApplied,
      'CDP Emulation.setEmulatedMedia(reduce) did not apply (matchMedia still false)');

    // 3) Re-open the overview under the emulated media (the CDP round-trip can leave the
    //    DOM/context in flux; a fresh navigation gives a stable page with RM active), then
    //    hold :active on a row link and read the computed transform — it must be none.
    await openDepartments(driver, application_host);
    var link2 = await driver.wait(
      until.elementLocated(By.css('tr[data-vpp-department-list-mode="readonly"] .departments-name-cell a')),
      3000
    );
    var actions2 = driver.actions({ async: true });
    await actions2.move({ origin: link2 }).press().perform();
    await driver.sleep(150);
    var underRM = await driver.executeScript(
      'var el=arguments[0]; return {' +
      'transform:getComputedStyle(el).transform,' +
      'active:el.matches(":active"),' +
      'hover:el.matches(":hover")};',
      link2
    );
    await driver.actions({ async: true }).release().perform();
    assert(underRM.active,
      'precondition under RM: link should be :active under press, got :active=' + underRM.active);
    assert(underRM.transform === 'none',
      'reduced-motion: active link transform must be suppressed to "none", got ' + underRM.transform);

    // 4) Reset the emulated media and prove it cleared.
    await setReducedMotion(driver, false);
    var mqCleared = await driver.executeScript(
      'return window.matchMedia("(prefers-reduced-motion: reduce)").matches'
    );
    assert(!mqCleared,
      'CDP reset did not clear prefers-reduced-motion (matchMedia still true)');

    // 5) Secondary assertion: the loaded CSS contains the scoped reduced-motion rule.
    var hasRule = await driver.executeScript(function () {
      for (var i = 0; i < document.styleSheets.length; i++) {
        try {
          var rules = document.styleSheets[i].cssRules;
          for (var j = 0; j < rules.length; j++) {
            var t = rules[j].cssText || '';
            if (t.indexOf('prefers-reduced-motion') > -1 &&
                t.indexOf('departments-page') > -1 &&
                t.indexOf('transform') > -1 &&
                t.indexOf('none') > -1) {
              return true;
            }
          }
        } catch (e) { /* cross-origin */ }
      }
      return false;
    });
    assert(hasRule,
      'expected a scoped .departments-page reduced-motion rule neutralizing transform in the loaded CSS');
  });

  // RU long-text geometry. Switch to Russian (GET /language/ru), re-open the page, and
  // assert no horizontal overflow / clip at 390px.
  it('RU locale (390px): localized labels wrap without overflow or clip', async function () {
    await open_page_func({ url: application_host + 'language/ru', driver: driver });
    await setViewport(driver, 390, 844);
    await openDepartments(driver, application_host);
    await driver.sleep(300);

    var g = await driver.executeScript(function () {
      var de = document.documentElement;
      // data-label::before text on mobile cards carries the localized column headers.
      var cells = document.querySelectorAll('td[data-label]');
      var maxRight = 0;
      var sampleTexts = [];
      for (var i = 0; i < cells.length; i++) {
        var before = cells[i].getBoundingClientRect();
        if (before.right > maxRight) maxRight = before.right;
        if (i < 6) sampleTexts.push(cells[i].getAttribute('data-label'));
      }
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        innerWidth: window.innerWidth,
        maxCellRight: maxRight,
        sampleLabels: sampleTexts
      };
    });
    assert(g.maxCellRight > 0, 'RU: no td[data-label] cells found');
    assert(g.scrollWidth <= g.clientWidth + 1,
      'RU: horizontal overflow scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
    assert(g.scrollWidth <= g.innerWidth + 1,
      'RU: horizontal overflow scrollWidth=' + g.scrollWidth + ' > innerWidth=' + g.innerWidth);
    assert(g.maxCellRight <= g.innerWidth + 1,
      'RU: cell right edge (' + g.maxCellRight + ') exceeds viewport (' + g.innerWidth + ')');

    await capture(driver, 'departments_390x844_ru');
  });

  // KK long-text geometry. Switch to Kazakh (GET /language/kk), re-open the page,
  // and assert no horizontal overflow / clip at 390px — KK Cyrillic labels are long.
  it('KK locale (390px): localized labels wrap without overflow or clip', async function () {
    await open_page_func({ url: application_host + 'language/kk', driver: driver });
    await setViewport(driver, 390, 844);
    await openDepartments(driver, application_host);
    await driver.sleep(300);

    var g = await driver.executeScript(function () {
      var de = document.documentElement;
      var cells = document.querySelectorAll('td[data-label]');
      var maxRight = 0;
      for (var i = 0; i < cells.length; i++) {
        var before = cells[i].getBoundingClientRect();
        if (before.right > maxRight) maxRight = before.right;
      }
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        innerWidth: window.innerWidth,
        maxCellRight: maxRight
      };
    });
    assert(g.maxCellRight > 0, 'KK: no td[data-label] cells found');
    assert(g.scrollWidth <= g.clientWidth + 1,
      'KK: horizontal overflow scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
    assert(g.scrollWidth <= g.innerWidth + 1,
      'KK: horizontal overflow scrollWidth=' + g.scrollWidth + ' > innerWidth=' + g.innerWidth);
    assert(g.maxCellRight <= g.innerWidth + 1,
      'KK: cell right edge (' + g.maxCellRight + ') exceeds viewport (' + g.innerWidth + ')');

    await capture(driver, 'departments_390x844_kk');
  });

  // Visual matrix: 6 states (3 viewports x 2 themes). Default locale (en).
  it('captures the 6-state visual matrix (1440/1024/390 x light/dark)', async function () {
    // Ensure default locale (en) for the matrix; language switch persists across tests.
    await open_page_func({ url: application_host + 'language/en', driver: driver });
    await openDepartments(driver, application_host);
    var states = [
      { w: 1440, h: 900, theme: 'light' },
      { w: 1024, h: 768, theme: 'light' },
      { w: 390, h: 844, theme: 'light' },
      { w: 1440, h: 900, theme: 'dark' },
      { w: 1024, h: 768, theme: 'dark' },
      { w: 390, h: 844, theme: 'dark' }
    ];
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      await setViewport(driver, s.w, s.h);
      await setTheme(driver, s.theme);
      // Re-open to settle layout at the new viewport before capturing.
      await openDepartments(driver, application_host);
      await driver.sleep(150);
      await capture(driver, 'departments_' + s.w + 'x' + s.h + '_' + s.theme);
    }
  });
});
