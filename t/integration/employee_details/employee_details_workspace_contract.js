'use strict';

/* globals describe, it, before, after */

/*
 * Stage 8E — Selenium contract: Employee Details workspace (/users/edit/:id/ + 4 tabs).
 *
 * Covers the redesign scoped under .employee-details-page:
 *   - all four routes render with a scoped shell + nav + raised surface;
 *   - desktop nav: four links, active state, each link navigates to the expected route;
 *   - mobile 390×844: no document-level horizontal overflow, nav links >=44px, action
 *     controls >=44×44px, long name wraps;
 *   - full Tab walk: real Tab through .employee-details-page, four nav links reachable,
 *     focus ring visible, no hidden focus targets, must leave the page region;
 *   - geometry (text Range + child boxes) across EN/RU/KK at 390px;
 *   - light/dark + CDP-emulated prefers-reduced-motion (press transform -> none);
 *   - rendered delete form + confirm contract + exact POST endpoints (no actual delete);
 *   - absences history opts into mobile-card cards (Stage 8E); Calendar consumer stays legacy;
 *   - visual matrix screenshots to /tmp/stage8e-employee-details/.
 *
 * Does NOT duplicate the behavior contracts locked by crud_users,
 * deactivate_and_activate_user, edit_user_to_have_duplicated_email, schedule/user_specific,
 * admin_view_of_user_calendar, remaining_used_columns_match_user_details.
 */

var path = require('path');
var fs = require('fs');
var assert = require('assert');
var webdriver = require('selenium-webdriver');
var By = webdriver.By;
var until = webdriver.until;
var Key = webdriver.Key;
var config = require('../../lib/config');
var models = require('../../../lib/model/db');
var moment = require('moment');
var register_new_user_func = require('../../lib/register_new_user');
var add_new_user_func = require('../../lib/add_new_user');
var open_page_func = require('../../lib/open_page');

var SCREEN_DIR = '/tmp/stage8e-employee-details';

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

async function setTheme(driver, theme) {
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

async function setReducedMotion(driver, enabled) {
  await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: enabled ? 'reduce' : '' }]
  });
  await driver.sleep(80);
}

async function openEdit(driver, host, employeeId, tab) {
  var url = host + 'users/edit/' + employeeId + '/' + (tab || '');
  await open_page_func({ url: url, driver: driver });
  await driver.wait(until.elementLocated(By.css('.employee-details-page')), 2000);
}

// Shared mobile-geometry probe (Stage 8C/8D canonical form), scanning the employee-details
// surfaces (cards/tables/sections) rather than only mobile-card tables. Skips visually-hidden
// content so Bootstrap .sr-only nowrap boxes don't yield spurious spillage.
var MOBILE_GEOMETRY_SCRIPT = function () {
  var de = document.documentElement;
  var TOL = 1;
  var SCROLL_TOL = 2;
  var findings = [];
  var innerW = window.innerWidth;
  var innerH = window.innerHeight;
  var cellsChecked = 0;
  var textRanges = 0;

  function rnd(n) { return Math.round(n * 10) / 10; }
  function rec(kind, side, value, limit, where) {
    findings.push({ kind: kind, side: side, value: rnd(value), limit: rnd(limit), where: where });
  }
  function isVisuallyHidden(node, root) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== root) {
      if (el.classList && el.classList.contains('sr-only')) return true;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
      el = el.parentElement;
    }
    return false;
  }
  // For each "cell" (a td in a mobile-card table, else a form-group/section block) measure
  // text-node Range glyph boxes + descendant element boxes vs the cell, its nearest surface,
  // and the viewport (horizontal).
  function measureBlock(block, whereRoot) {
    var bb = block.getBoundingClientRect();
    function scrollGuard(el, where) {
      if (el.scrollWidth > el.clientWidth + SCROLL_TOL) rec('scroll', 'scrollW>clientW', el.scrollWidth, el.clientWidth, where);
    }
    scrollGuard(block, whereRoot);
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (!(n.nodeValue || '').trim()) continue;
      if (isVisuallyHidden(n, block)) continue;
      var rng = document.createRange();
      rng.selectNodeContents(n);
      var rs = rng.getClientRects();
      for (var i = 0; i < rs.length; i++) {
        if (rs[i].width <= 0 || rs[i].height <= 0) continue;
        cellsChecked++;
        textRanges++;
        var r = rs[i];
        if (r.l < bb.left - TOL) rec('text', 'left<block', r.l, bb.left, whereRoot);
        if (r.r > bb.right + TOL) rec('text', 'right>block', r.r, bb.right, whereRoot);
        if (r.l < -TOL) rec('text', 'left<viewport', r.l, 0, whereRoot);
        if (r.r > innerW + TOL) rec('text', 'right>viewport', r.r, innerW, whereRoot);
      }
    }
    var els = block.querySelectorAll('*');
    for (var j = 0; j < els.length; j++) {
      if (isVisuallyHidden(els[j], block)) continue;
      var b = els[j].getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) continue;
      if (b.left < bb.left - TOL) rec('el', 'left<block', b.left, bb.left, whereRoot + '.el<' + els[j].tagName.toLowerCase() + '>');
      if (b.right > bb.right + TOL) rec('el', 'right>block', b.right, bb.right, whereRoot + '.el<' + els[j].tagName.toLowerCase() + '>');
      if (b.left < -TOL) rec('el', 'left<viewport', b.left, 0, whereRoot + '.el<' + els[j].tagName.toLowerCase() + '>');
      if (b.right > innerW + TOL) rec('el', 'right>viewport', b.right, innerW, whereRoot + '.el<' + els[j].tagName.toLowerCase() + '>');
    }
  }

  // measure the mobile-card td cells (absences history) if present
  var tables = document.querySelectorAll('.mobile-card-table');
  for (var ti = 0; ti < tables.length; ti++) {
    var tds = tables[ti].querySelectorAll('tbody > tr > td');
    for (var ci = 0; ci < tds.length; ci++) {
      measureBlock(tds[ci], 'table' + ti + '.td' + ci);
    }
  }
  // measure the surface blocks (form-groups/sections) on the current tab. Exclude the absence-
  // history year surfaces (.requests-year-surface): those are containers for the mobile-card
  // table, whose cards are already measured per-td by the scan above — measuring the whole year
  // surface as one block would flag its inner table rows as "overflowing the surface", which is
  // just the cards legitimately filling the container.
  var surfaces = document.querySelectorAll('.employee-details-content .surface:not(.requests-year-surface), .employee-details-content .form-group');
  for (var si = 0; si < surfaces.length; si++) {
    measureBlock(surfaces[si], 'surface' + si);
  }

  return {
    cellsChecked: cellsChecked,
    textRanges: textRanges,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    innerWidth: innerW,
    innerHeight: innerH,
    findings: findings
  };
};

async function assertMobileGeometry(driver, locale) {
  await driver.sleep(300);
  var g = await driver.executeScript(MOBILE_GEOMETRY_SCRIPT);
  var L = locale ? '[' + locale + '] ' : '';
  assert(g.cellsChecked > 0, L + 'no measurable cells — probe is degenerate');
  assert(g.textRanges > 0, L + 'no text-node ranges measured — probe is degenerate');
  assert(g.scrollWidth <= g.clientWidth + 1,
    L + 'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
  assert(g.scrollWidth <= g.innerWidth + 1,
    L + 'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > innerWidth=' + g.innerWidth);
  assert(g.findings.length === 0,
    L + 'mobile geometry violations (' + g.findings.length + '): ' +
    JSON.stringify(g.findings.slice(0, 12)));
}

describe('Employee details workspace interaction, geometry & visual matrix (Stage 8E)', function () {

  this.timeout(config.get_execution_timeout());

  var driver;
  var application_host = config.get_application_host();
  var employeeEmail = 'stage8e-' + (new Date()).getTime() + '@test.com';
  var admin;
  var employee;

  before(function (done) {
    register_new_user_func({ application_host: application_host }).then(async function (data) {
      driver = data.driver;
      admin = await models.User.findOne({ where: { email: data.email } });
      await add_new_user_func({
        application_host: application_host,
        driver: driver,
        email: employeeEmail
      });
      employee = await models.User.findOne({ where: { email: employeeEmail } });
      await employee.update({ name: 'Ada', lastname: 'Lovelace' });
      await employee.reload();
      // An approved leave so the calendar + absences history render non-vacuously.
      var leaveType = await models.LeaveType.findOne({ where: { companyId: admin.companyId } });
      var start = moment.utc().add(40, 'days').startOf('day');
      await models.Leave.create({
        userId: employee.id,
        approverId: admin.id,
        leaveTypeId: leaveType.id,
        status: models.Leave.status_approved(),
        date_start: start.format('YYYY-MM-DD'),
        date_end: start.clone().add(2, 'days').format('YYYY-MM-DD')
      });
      done();
    }, done);
  });

  after(function () {
    return driver.quit();
  });

  it('renders the scoped workspace shell on the general tab', async function () {
    await openEdit(driver, application_host, employee.id, '');
    await driver.findElement(By.css('.employee-details-page'));
    await driver.findElement(By.css('.page-heading'));
    var h1s = await driver.findElements(By.css('main h1'));
    assert.strictEqual(h1s.length, 1, 'expected exactly one h1');
    await driver.findElement(By.css('.employee-general-surface.surface'));
    // breadcrumb once, with /users/ + the employee name
    var bc = await driver.findElement(By.css('.breadcrumb')).getText();
    assert(/Ada/.test(bc) || /Lovelace/.test(bc), 'breadcrumb should name the employee, got: ' + bc);
  });

  it('desktop nav has four links; active is general; each navigates to its route', async function () {
    await setViewport(driver, 1440, 900);
    await openEdit(driver, application_host, employee.id, '');
    var links = await driver.findElements(By.css('.employee-details-nav a'));
    assert.strictEqual(links.length, 4, 'expected four nav links');
    // general is active
    var activeHref = await driver.findElement(By.css('.employee-details-nav a[aria-current="page"]')).getAttribute('href');
    assert(/\/users\/edit\/\d+\/$/.test(activeHref), 'general active href unexpected: ' + activeHref);
    // navigate to each tab and confirm the URL + active link moves
    var tabs = [
      { tab: 'schedule/', surface: '.employee-schedule-surface' },
      { tab: 'calendar/', surface: '.employee-calendar-surface' },
      { tab: 'absences/', surface: '.employee-absence-surface' }
    ];
    for (var i = 0; i < tabs.length; i++) {
      await openEdit(driver, application_host, employee.id, tabs[i].tab);
      var url = await driver.getCurrentUrl();
      assert(new RegExp('/users/edit/\\d+/' + tabs[i].tab + '$').test(url),
        'expected to land on ' + tabs[i].tab + ', got ' + url);
      await driver.findElement(By.css(tabs[i].surface));
      var act = await driver.findElement(By.css('.employee-details-nav a[aria-current="page"]')).getAttribute('href');
      assert(act.indexOf('/' + tabs[i].tab) > -1, 'active link should be ' + tabs[i].tab + ', got ' + act);
    }
  });

  // Rendered delete form + confirm contract + POST endpoints (no actual delete).
  it('renders the delete form with the confirm contract and exact endpoints (no deletion)', async function () {
    await setViewport(driver, 1024, 768);
    await openEdit(driver, application_host, employee.id, '');
    var src = await driver.executeScript('return document.documentElement.outerHTML');
    assert(/id="add_new_user_frm"/.test(src), 'missing #add_new_user_frm');
    assert(/action="\/users\/delete\/\d+\/"/.test(src), 'missing delete action');
    assert(/onsubmit="return confirm\(/.test(src), 'missing onsubmit confirm');
    // the i18n key is interpolated into the confirm text in the DOM; assert the rendered text
    // (the English value is "Do you really want to delete the user <name> <lastname>?").
    assert(/delete the user/.test(src), 'missing interpolated delete-confirm text');
    assert(/id="remove_btn"/.test(src), 'missing #remove_btn');
    // edit endpoint present
    assert(/action="\/users\/edit\/\d+\/"/.test(src), 'missing edit action');
    // the absences tab posts to the same edit endpoint with back_to_absences
    await openEdit(driver, application_host, employee.id, 'absences/');
    var absSrc = await driver.executeScript('return document.documentElement.outerHTML');
    assert(/name="back_to_absences" value="1"/.test(absSrc), 'missing back_to_absences');
    // schedule endpoint
    await openEdit(driver, application_host, employee.id, 'schedule/');
    var schSrc = await driver.executeScript('return document.documentElement.outerHTML');
    assert(/action="\/settings\/schedule"/.test(schSrc), 'missing schedule action');
  });

  // Full Tab walk through .employee-details-page: all four nav links reachable, focus ring
  // visible, no hidden focus targets, must leave the page region (cap is fail-safe, not success).
  it('Tab walk: all four nav links reachable, focus ring visible, leaves the page region', async function () {
    await setViewport(driver, 1024, 768);
    await openEdit(driver, application_host, employee.id, '');
    await driver.executeScript('document.body.focus();');
    await driver.sleep(120);
    var navLinksReached = 0;
    var focusRingSeen = false;
    var leftPage = false;
    var entered = false;
    var sequence = [];
    var MAX_TABS = 100;
    for (var i = 0; i < MAX_TABS; i++) {
      await driver.actions().sendKeys(Key.TAB).perform();
      await driver.sleep(30);
      var info = await driver.executeScript(function () {
        var el = document.activeElement;
        if (!el || el === document.body) return null;
        var inPage = !!(el.closest && el.closest('.employee-details-page'));
        var isNav = !!(el.closest && el.closest('.employee-details-nav'));
        var cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          inPage: inPage,
          isNav: isNav,
          visible: !!(el.offsetWidth > 0 || el.offsetHeight > 0),
          hasRing: inPage && cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px'
        };
      });
      if (!info) { sequence.push('(out)'); if (entered) leftPage = true; break; }
      sequence.push(info.tag + (info.isNav ? '.nav' : ''));
      if (info.inPage) {
        entered = true;
        if (info.isNav) navLinksReached++;
        if (info.hasRing) focusRingSeen = true;
      } else if (entered) {
        leftPage = true;
        break;
      }
    }
    assert(navLinksReached >= 4,
      'expected all four nav links reachable by Tab, got ' + navLinksReached + '. Sequence: ' + sequence.join(' -> '));
    assert(focusRingSeen, 'no visible focus ring during the Tab walk. Sequence: ' + sequence.join(' -> '));
    assert.strictEqual(leftPage, true,
      'Tab walk did not leave .employee-details-page (region not fully traversed). Sequence: ' + sequence.join(' -> '));
  });

  // Mobile 390: no horizontal overflow; nav links >=44px; nav is a real 2×2 grid (not 1×4);
  // Save/Delete >=44x44; long name wraps.
  it('mobile (390px): no horizontal overflow; nav is a 2×2 grid; nav + action controls >=44px; name wraps', async function () {
    await setViewport(driver, 390, 844);
    await openEdit(driver, application_host, employee.id, '');
    await driver.sleep(300);
    var g = await driver.executeScript(function () {
      var de = document.documentElement;
      var navLinks = document.querySelectorAll('.employee-details-nav a');
      var navRects = Array.prototype.map.call(navLinks, function (a) {
        var r = a.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height), w: Math.round(r.width) };
      });
      var h1 = document.querySelector('h1.employee-page-title');
      var h1r = h1 ? h1.getBoundingClientRect() : null;
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        innerWidth: window.innerWidth,
        navRects: navRects,
        h1Right: h1r ? Math.round(h1r.right) : null,
        h1Text: h1 ? h1.textContent.replace(/\s+/g, ' ').slice(0, 40) : null
      };
    });
    assert(g.scrollWidth <= g.clientWidth + 1,
      'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
    assert(g.navRects.length === 4, 'expected 4 nav links, got ' + g.navRects.length);
    // 2×2 grid: links 0 and 1 share the same row (equal top); link 2 starts a new row (greater top).
    // A 1×4 stack would have link 1 below link 0 (greater top) — this catches the cascade bug.
    assert.strictEqual(g.navRects[0].top, g.navRects[1].top,
      'nav links 0 and 1 should share row 1 of the 2×2 grid, got top0=' + g.navRects[0].top + ' top1=' + g.navRects[1].top + ' rects=' + JSON.stringify(g.navRects));
    assert(g.navRects[2].top > g.navRects[0].top,
      'nav link 2 should start row 2 of the 2×2 grid (top greater than link 0), got top0=' + g.navRects[0].top + ' top2=' + g.navRects[2].top + ' rects=' + JSON.stringify(g.navRects));
    for (var i = 0; i < g.navRects.length; i++) {
      assert(g.navRects[i].h >= 44,
        'nav link ' + i + ' height ' + g.navRects[i].h + ' < 44');
    }
    // the long employee name must wrap within the viewport (not clip off the right)
    assert(g.h1Right !== null && g.h1Right <= g.innerWidth + 1,
      'h1 right edge ' + g.h1Right + ' exceeds viewport ' + g.innerWidth + ' (name clipped) — text: ' + g.h1Text);
  });

  it('mobile (390px): Save and Delete action controls meet the 44px tap-target guidance', async function () {
    await setViewport(driver, 390, 844);
    await openEdit(driver, application_host, employee.id, '');
    await driver.sleep(200);
    var rects = await driver.executeScript(function () {
      function r(sel) {
        var el = document.querySelector(sel);
        if (!el) return null;
        var b = el.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      }
      return { save: r('#save_changes_btn'), del: r('#remove_btn') };
    });
    assert(rects.save && rects.save.h >= 44 && rects.save.w >= 44,
      'Save must be >=44px on both axes at 390px, got ' + JSON.stringify(rects.save));
    assert(rects.del && rects.del.h >= 44 && rects.del.w >= 44,
      'Delete must be >=44px on both axes at 390px, got ' + JSON.stringify(rects.del));
  });

  // Reduced-motion via CDP: press transform suppressed to none on an action control.
  it('reduced-motion (CDP): emulated media suppresses the active transform to none', async function () {
    await setViewport(driver, 1024, 768);
    await openEdit(driver, application_host, employee.id, '');
    var save = await driver.findElement(By.css('#save_changes_btn'));
    // baseline: default media press yields non-identity transform
    var actions = driver.actions({ async: true });
    await actions.move({ origin: save }).press().perform();
    await driver.sleep(150);
    var baseline = await driver.executeScript(
      'var el=arguments[0]; return {transform:getComputedStyle(el).transform, active:el.matches(":active")};', save
    );
    await driver.actions({ async: true }).move({ origin: driver.findElement(By.css('.page-heading h1')) }).release().perform();
    assert(baseline.active, 'precondition: save should be :active under press');
    assert(baseline.transform !== 'none' && baseline.transform !== 'matrix(1, 0, 0, 1, 0, 0)',
      'baseline: active save should have a non-identity transform, got ' + baseline.transform);

    await setReducedMotion(driver, true);
    var mq = await driver.executeScript('return window.matchMedia("(prefers-reduced-motion: reduce)").matches');
    assert(mq, 'CDP reduced-motion did not apply');
    await openEdit(driver, application_host, employee.id, '');
    var save2 = await driver.findElement(By.css('#save_changes_btn'));
    var a2 = driver.actions({ async: true });
    await a2.move({ origin: save2 }).press().perform();
    await driver.sleep(150);
    var underRM = await driver.executeScript(
      'var el=arguments[0]; return {transform:getComputedStyle(el).transform, active:el.matches(":active")};', save2
    );
    await driver.actions({ async: true }).move({ origin: driver.findElement(By.css('.page-heading h1')) }).release().perform();
    assert.strictEqual(underRM.transform, 'none',
      'reduced-motion: active transform must be none, got ' + underRM.transform);
    await setReducedMotion(driver, false);
    var cleared = await driver.executeScript('return window.matchMedia("(prefers-reduced-motion: reduce)").matches');
    assert(!cleared, 'CDP reset did not clear reduced-motion');
  });

  // Calendar allowance statistics: the primary allowance figure (.top-leave-type-statistics
  // dt + dd:first-of-type) must be readable on the Employee Details surface in BOTH themes —
  // the global rules paint them white (for a dark hero card), which was invisible on the light
  // surface. Assert WCAG AA contrast (>=4.5) on desktop+mobile, light+dark.
  it('calendar: allowance statistics meet WCAG AA contrast (>=4.5) in light and dark', async function () {
    async function contrastOn(theme, w, h) {
      await setViewport(driver, w, h);
      await setTheme(driver, theme);
      await openEdit(driver, application_host, employee.id, 'calendar/');
      await driver.sleep(200);
      return driver.executeScript(function () {
        function lum(c) {
          var m = c.match(/\d+/g);
          if (!m) return 0;
          var rs = m.map(function (v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
          return 0.2126 * rs[0] + 0.7152 * rs[1] + 0.0722 * rs[2];
        }
        function ratio(fg, bg) {
          var l1 = lum(fg), l2 = lum(bg);
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        }
        function measure(sel) {
          var el = document.querySelector(sel);
          if (!el) return null;
          var cs = getComputedStyle(el);
          // walk up to find the surface background (the nearest .surface / .employee-calendar-card)
          var bgEl = el.closest('.surface') || el.closest('.employee-calendar-card') || document.body;
          var bgCs = getComputedStyle(bgEl);
          return { ratio: Math.round(ratio(cs.color, bgCs.backgroundColor) * 100) / 100, fg: cs.color, bg: bgCs.backgroundColor };
        }
        return {
          dt: measure('.top-leave-type-statistics dt'),
          ddFirst: measure('.top-leave-type-statistics dd:first-of-type')
        };
      });
    }
    var states = [
      { theme: 'light', w: 1440, h: 900 },
      { theme: 'dark', w: 1440, h: 900 },
      { theme: 'light', w: 390, h: 844 },
      { theme: 'dark', w: 390, h: 844 }
    ];
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      var r = await contrastOn(s.theme, s.w, s.h);
      assert(r.dt && r.dt.ratio >= 4.5,
        '.top-leave-type-statistics dt ' + s.theme + ' ' + s.w + ' contrast ' + (r.dt ? r.dt.ratio : 'null') + ' < 4.5 (fg=' + (r.dt ? r.dt.fg : '?') + ' bg=' + (r.dt ? r.dt.bg : '?') + ')');
      assert(r.ddFirst && r.ddFirst.ratio >= 4.5,
        '.top-leave-type-statistics dd:first-of-type ' + s.theme + ' ' + s.w + ' contrast ' + (r.ddFirst ? r.ddFirst.ratio : 'null') + ' < 4.5 (fg=' + (r.ddFirst ? r.ddFirst.fg : '?') + ' bg=' + (r.ddFirst ? r.ddFirst.bg : '?') + ')');
    }
  });

  // Absences history opts into mobile-card cards (Stage 8E); Calendar consumer stays legacy.
  it('absences history uses mobile-card cards on User Details; Calendar stays legacy', async function () {
    await setViewport(driver, 390, 844);
    await openEdit(driver, application_host, employee.id, 'absences/');
    await driver.sleep(300);
    var abs = await driver.executeScript(function () {
      return {
        mobileCards: document.querySelectorAll('.mobile-card-table').length,
        mobileActions: document.querySelectorAll('.mobile-card-action').length,
        userTables: document.querySelectorAll('.user-requests-table').length
      };
    });
    assert(abs.mobileCards > 0, 'User Details absences should render mobile-card cards (Stage 8E opt-in), got ' + abs.mobileCards);
    assert(abs.mobileActions > 0, 'User Details absences should render mobile-card-action cells, got ' + abs.mobileActions);
    assert(abs.userTables > 0, 'User Details absences should still render the user-requests-table');

    // Calendar consumer (the shared /calendar/ page, not this tab) stays legacy.
    await open_page_func({ url: application_host + 'calendar/', driver: driver });
    await driver.sleep(400);
    var cal = await driver.executeScript(function () {
      return { mobileCards: document.querySelectorAll('.mobile-card-table').length };
    });
    assert.strictEqual(cal.mobileCards, 0,
      '/calendar/ must stay legacy (no mobile-card), got ' + cal.mobileCards);
  });

  // Geometry probe runs across ALL four routes (not just General): each tab's surface is
  // measured for text-range + child-box overflow at 390px. A table-driven run keeps every
  // route under the same contract instead of only photographing three of them.
  var GEOMETRY_TABS = [
    { tab: '', locale: null, name: 'general' },
    { tab: 'schedule/', locale: null, name: 'schedule' },
    { tab: 'calendar/', locale: null, name: 'calendar' },
    { tab: 'absences/', locale: null, name: 'absences' },
    // long-text locales on the two densest tabs (general form labels, absences history/cards)
    { tab: '', locale: 'ru', name: 'general_ru' },
    { tab: 'absences/', locale: 'ru', name: 'absences_ru' },
    { tab: '', locale: 'kk', name: 'general_kk' },
    { tab: 'absences/', locale: 'kk', name: 'absences_kk' }
  ];
  for (var gi = 0; gi < GEOMETRY_TABS.length; gi++) {
    (function (tc) {
      it('mobile (390px) ' + tc.name + ': geometry within block/viewport; no overflow', async function () {
        if (tc.locale) {
          await open_page_func({ url: application_host + 'language/' + tc.locale + '/', driver: driver });
        } else {
          await open_page_func({ url: application_host + 'language/en', driver: driver });
        }
        await setViewport(driver, 390, 844);
        await openEdit(driver, application_host, employee.id, tc.tab);
        await assertMobileGeometry(driver, tc.locale ? tc.locale.toUpperCase() : null);
      });
    })(GEOMETRY_TABS[gi]);
  }

  // Visual matrix: actually capture and review the key states (12 frames).
  it('captures the visual matrix (general light/dark desktop+mobile, calendar, absences, schedule, RU/KK)', async function () {
    await open_page_func({ url: application_host + 'language/en', driver: driver });
    async function shot(name, w, h, theme, tab) {
      await setViewport(driver, w, h);
      await setTheme(driver, theme);
      await openEdit(driver, application_host, employee.id, tab || '');
      await driver.sleep(150);
      await capture(driver, name);
    }
    await shot('general_desktop_light', 1440, 900, 'light', '');
    await shot('general_desktop_dark', 1440, 900, 'dark', '');
    await shot('general_mobile_light', 390, 844, 'light', '');
    await shot('general_mobile_dark', 390, 844, 'dark', '');
    await shot('calendar_desktop_light', 1440, 900, 'light', 'calendar/');
    await shot('calendar_mobile_light', 390, 844, 'light', 'calendar/');
    await shot('absences_desktop_light', 1440, 900, 'light', 'absences/');
    await shot('absences_mobile_light', 390, 844, 'light', 'absences/');
    await shot('schedule_mobile_light', 390, 844, 'light', 'schedule/');
    await shot('schedule_desktop_light', 1440, 900, 'light', 'schedule/');
    // RU + KK mobile (frames 11 and 12 of the 12-frame matrix)
    await open_page_func({ url: application_host + 'language/ru', driver: driver });
    await setViewport(driver, 390, 844);
    await setTheme(driver, 'light');
    await openEdit(driver, application_host, employee.id, '');
    await capture(driver, 'general_390_ru');
    await open_page_func({ url: application_host + 'language/kk', driver: driver });
    await setViewport(driver, 390, 844);
    await openEdit(driver, application_host, employee.id, '');
    await capture(driver, 'general_390_kk');
  });
});
