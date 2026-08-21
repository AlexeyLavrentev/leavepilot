'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const dayjs = require('../../../lib/util/date');
const By = require('selenium-webdriver').By;
const Key = require('selenium-webdriver').Key;
const until = require('selenium-webdriver').until;
const expect = require('chai').expect;

const config = require('../../lib/config');
const models = require('../../../lib/model/db');
const registerNewUser = require('../../lib/register_new_user');
const addNewUser = require('../../lib/add_new_user');
const openPage = require('../../lib/open_page');
const setViewport = require('../../lib/set_viewport');

describe('Team View sticky header', function() {
  this.timeout(config.get_execution_timeout() * 3);

  const applicationHost = config.get_application_host();
  const artifactDirectory = '/tmp/timeoff-stage6c-sticky-header/visual-matrix';
  const firstEmployeeEmail = `sticky-first-${Date.now()}@test.com`;
  const secondEmployeeEmail = `sticky-second-${Date.now()}@test.com`;
  let driver;
  let browserProcessCountBefore;
  let browserName;
  let browserVersion;
  let visualManifest = [];

  function browserProcessCount() {
    const result = childProcess.spawnSync('pgrep', [
      '-f',
      'chrome-headless-shell|chromedriver',
    ], {encoding: 'utf8'});
    if (result.status !== 0 || !(result.stdout || '').trim()) { return 0; }
    return result.stdout.trim().split(/\s+/).length;
  }

  async function applyTheme(theme) {
    await driver.executeScript(function(value) {
      if (value === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
    }, theme);
  }

  async function openAndInflate(months) {
    await openPage({
      url: `${applicationHost}calendar/teamview/?months=${months}&grouped_mode=1`,
      driver,
    });
    await driver.wait(until.elementsLocated(By.css('.team-view-table-shell')), 5000);
    await driver.wait(async function() {
      return (await driver.findElements(By.css('.team-view-table-shell'))).length >= 2;
    }, 5000);
    await driver.wait(async function() {
      return (await driver.findElements(By.css('.team-view-sticky-header-table thead th'))).length > 0;
    }, 5000);
    const result = await driver.executeScript(function() {
      const shells = Array.from(document.querySelectorAll('.team-view-table-shell'));
      return shells.map(function(shell, shellIndex) {
        const table = shell.querySelector('.team-view-table-container > .team-view-table:not(.team-view-sticky-header-table)');
        const tbody = table && table.querySelector('tbody');
        const sourceRows = tbody && Array.from(tbody.querySelectorAll('tr.teamview-user-list-row:not([data-stage6c-test-clone])'));
        if (!table || !tbody || !sourceRows.length) { return {shellIndex, clones: 0}; }
        shell.querySelector('.team-view-table-container').style.maxWidth = '900px';
        const source = sourceRows[0];
        for (let index = 0; index < 28; index += 1) {
          const clone = source.cloneNode(true);
          clone.setAttribute('data-stage6c-test-clone', 'true');
          clone.setAttribute('aria-hidden', 'true');
          clone.querySelectorAll('[id]').forEach(function(element) { element.removeAttribute('id'); });
          tbody.insertBefore(clone, source);
        }
        return {shellIndex, clones: 28, rows: tbody.rows.length};
      });
    });
    expect(result).to.have.length.at.least(2);
    expect(result[0].rows).to.be.greaterThan(28);
    expect(result[1].rows).to.be.greaterThan(28);
    await driver.sleep(180);
  }

  async function activeOverlayCount() {
    return driver.executeScript(function() {
      return Array.from(document.querySelectorAll('.team-view-sticky-header'))
        .filter(function(overlay) { return !overlay.hidden; }).length;
    });
  }

  async function scrollShellPastTop(index, offset) {
    await driver.executeScript(function(shellIndex, amount) {
      const shell = document.querySelectorAll('.team-view-table-shell')[shellIndex];
      const top = shell.getBoundingClientRect().top + window.pageYOffset;
      window.scrollTo(0, top + amount);
    }, index, offset || 180);
    await driver.wait(async function() { return (await activeOverlayCount()) === 1; }, 2000);
    await driver.sleep(80);
  }

  async function setHorizontal(index, mode) {
    const result = await driver.executeScript(function(shellIndex, position) {
      const shell = document.querySelectorAll('.team-view-table-shell')[shellIndex];
      const container = shell.querySelector('.team-view-table-container');
      const maximum = container.scrollWidth - container.clientWidth;
      const target = position === 'right' ? maximum : (position === 'middle' ? maximum / 2 : 0);
      container.scrollLeft = target;
      container.dispatchEvent(new Event('scroll'));
      return {maximum, target};
    }, index, mode);
    await driver.sleep(100);
    return result;
  }

  async function geometry(index) {
    return driver.executeScript(function(shellIndex) {
      function rect(element) {
        if (!element) { return null; }
        const value = element.getBoundingClientRect();
        return {
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          left: value.left,
          width: value.width,
          height: value.height,
        };
      }
      const shells = document.querySelectorAll('.team-view-table-shell');
      const shell = shells[shellIndex];
      const container = shell.querySelector('.team-view-table-container');
      const sourceTable = container.querySelector('.team-view-table:not(.team-view-sticky-header-table)');
      const sourceThead = sourceTable.querySelector('thead');
      const sourceHeaders = sourceThead.querySelectorAll('th');
      const sourceRow = sourceTable.querySelector('tbody tr.teamview-user-list-row:not([data-stage6c-test-clone])');
      const bodyCells = sourceRow.querySelectorAll('td');
      const overlay = shell.querySelector('.team-view-sticky-header');
      const viewport = overlay.querySelector('.team-view-sticky-header-viewport');
      const overlayTable = overlay.querySelector('.team-view-sticky-header-table');
      const cloneHeaders = overlayTable.querySelectorAll('th');
      const overlayStyle = getComputedStyle(overlay);
      const viewportStyle = getComputedStyle(viewport);
      const cloneNameRect = rect(cloneHeaders[0]);
      const sourceDateRect = rect(sourceHeaders[1]);
      const cloneDateRect = rect(cloneHeaders[1]);
      const bodyDeductedRect = rect(bodyCells[1]);
      const bodyDateRect = rect(bodyCells[2]);
      return {
        shellIndex,
        shellRect: rect(shell),
        containerRect: rect(container),
        sourceTheadRect: rect(sourceThead),
        sourceFirstHeaderRect: rect(sourceHeaders[0]),
        sourceDateRect,
        bodyDeductedRect,
        bodyDateRect,
        overlayRect: rect(overlay),
        cloneNameRect,
        cloneDateRect,
        sourceScrollLeft: container.scrollLeft,
        overlayScrollLeft: viewport.scrollLeft,
        sourceScrollWidth: container.scrollWidth,
        sourceClientWidth: container.clientWidth,
        overlayTableWidth: rect(overlayTable).width,
        activeOverlayCount: Array.from(document.querySelectorAll('.team-view-sticky-header')).filter(function(item) { return !item.hidden; }).length,
        overlayHidden: overlay.hidden,
        position: overlayStyle.position,
        zIndex: overlayStyle.zIndex,
        pointerEvents: overlayStyle.pointerEvents,
        viewportOverflowX: viewportStyle.overflowX,
        viewportOverflowY: viewportStyle.overflowY,
        sourceDepartmentText: (sourceHeaders[0].textContent || '').trim(),
        cloneDepartmentText: (cloneHeaders[0].textContent || '').trim(),
        sourceWeekdayText: Array.from(sourceHeaders).slice(1).map(function(item) { return (item.textContent || '').trim(); }),
        cloneWeekdayText: Array.from(cloneHeaders).slice(1).map(function(item) { return (item.textContent || '').trim(); }),
        cloneFocusableCount: overlay.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable]').length,
        cloneIdCount: overlay.querySelectorAll('[id]').length,
        cloneTbodyCount: overlay.querySelectorAll('tbody').length,
        sourceAriaHidden: sourceThead.getAttribute('aria-hidden'),
        pageY: window.pageYOffset,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        shellClasses: shell.className,
        // The scroll cue is derived from rounded integers while scrollLeft is
        // fractional, so a failure here needs the raw numbers to be readable.
        scrollMetrics: {
          scrollWidth: container.scrollWidth,
          clientWidth: container.clientWidth,
          scrollLeft: Math.round(container.scrollLeft * 100) / 100,
          derivedMax: container.scrollWidth - container.clientWidth,
          residual: Math.round(
            (container.scrollWidth - container.clientWidth - container.scrollLeft) * 100
          ) / 100,
          devicePixelRatio: window.devicePixelRatio,
        },
        alignmentDeltas: {
          overlayContainerLeft: rect(overlay).left - rect(container).left,
          overlayContainerWidth: rect(overlay).width - rect(container).width,
          cloneSourceDate: cloneDateRect.left - sourceDateRect.left,
          sourceHeaderBodyDate: sourceDateRect.left - bodyDateRect.left,
          cloneNameDeductedRight: cloneNameRect.right - bodyDeductedRect.right,
        },
      };
    }, index);
  }

  async function waitExpanded(trigger, expected, label) {
    await driver.wait(async function() {
      return (await trigger.getAttribute('aria-expanded')) === String(expected);
    }, 4000, `${label || 'popover trigger'} did not reach aria-expanded=${expected}`);
  }

  async function waitPopoverVisible(trigger, expected, label) {
    await driver.wait(async function() {
      return driver.executeScript(function(element) {
        const instance = window.jQuery(element).data('bs.popover');
        const tip = instance && instance.tip ? instance.tip() : null;
        return !!(tip && tip.is(':visible'));
      }, trigger).then(function(visible) { return visible === expected; });
    }, 4000, `${label || 'popover trigger'} did not reach visible=${expected}`);
  }

  async function captureVisualCase(testCase) {
    await setViewport(driver, {width: testCase.width, height: testCase.height});
    await openAndInflate(testCase.months);
    await applyTheme(testCase.theme);

    const shellIndex = testCase.vertical === 'transition' ? 1 : 0;
    if (testCase.vertical === 'start') {
      await driver.executeScript(function() {
        const shell = document.querySelector('.team-view-table-shell');
        window.scrollTo(0, shell.getBoundingClientRect().top + window.pageYOffset);
      });
      await driver.sleep(100);
    } else if (testCase.vertical === 'bottom') {
      await driver.executeScript(function() {
        const shell = document.querySelector('.team-view-table-shell');
        const bottom = shell.getBoundingClientRect().bottom + window.pageYOffset;
        const header = shell.querySelector('.team-view-table thead').getBoundingClientRect().height;
        window.scrollTo(0, bottom - header - 8);
      });
      await driver.sleep(100);
    } else {
      await scrollShellPastTop(shellIndex, testCase.vertical === 'transition' ? 120 : 220);
    }
    await setHorizontal(shellIndex, testCase.horizontal);

    const measurement = await geometry(shellIndex);
    const capabilities = await driver.getCapabilities();
    const entry = {
      name: testCase.name,
      viewport: {width: testCase.width, height: testCase.height},
      theme: testCase.theme,
      months: testCase.months,
      vertical: testCase.vertical,
      horizontal: testCase.horizontal,
      pageY: measurement.pageY,
      sourceTableIndex: shellIndex,
      sourceHeaderRect: measurement.sourceTheadRect,
      shellRect: measurement.shellRect,
      overlayRect: measurement.overlayRect,
      containerRect: measurement.containerRect,
      sourceScrollLeft: measurement.sourceScrollLeft,
      overlayScrollLeft: measurement.overlayScrollLeft,
      sourceTableScrollWidth: measurement.sourceScrollWidth,
      overlayTableWidth: measurement.overlayTableWidth,
      activeOverlayCount: measurement.activeOverlayCount,
      departmentText: measurement.cloneDepartmentText,
      weekdayText: measurement.cloneWeekdayText,
      pageOverflow: measurement.pageOverflow,
      alignmentDeltas: measurement.alignmentDeltas,
      zIndex: measurement.zIndex,
      pointerEvents: measurement.pointerEvents,
      focusableCloneDescendants: measurement.cloneFocusableCount,
      browser: `${capabilities.get('browserName')} ${capabilities.get('browserVersion')}`,
    };
    const screenshot = await driver.takeScreenshot();
    fs.writeFileSync(path.join(artifactDirectory, `${testCase.name}.png`), screenshot, 'base64');
    visualManifest.push(entry);
  }

  before(async function() {
    fs.mkdirSync(artifactDirectory, {recursive: true});
    browserProcessCountBefore = browserProcessCount();
    const registration = await registerNewUser({application_host: applicationHost});
    driver = registration.driver;
    await addNewUser({driver, application_host: applicationHost, email: firstEmployeeEmail});
    await addNewUser({driver, application_host: applicationHost, email: secondEmployeeEmail});

    const admin = await models.User.findOne({where: {email: registration.email}});
    const firstEmployee = await models.User.findOne({where: {email: firstEmployeeEmail}});
    const secondEmployee = await models.User.findOne({where: {email: secondEmployeeEmail}});
    const secondDepartment = await models.Department.create({
      name: 'Zeta Sticky Boundary Department',
      companyId: admin.companyId,
    });
    await secondEmployee.update({DepartmentId: secondDepartment.id});
    const leaveType = await models.LeaveType.findOne({where: {companyId: admin.companyId}});
    const leaveDate = dayjs.utc().startOf('month').add(7, 'days');
    while (leaveDate.isoWeekday() > 5) { leaveDate.add(1, 'day'); }
    await models.Leave.create({
      userId: firstEmployee.id,
      approverId: admin.id,
      leaveTypeId: leaveType.id,
      date_start: leaveDate.format('YYYY-MM-DD'),
      date_end: leaveDate.clone().add(1, 'day').format('YYYY-MM-DD'),
      day_part_start: models.Leave.leave_day_part_all(),
      day_part_end: models.Leave.leave_day_part_all(),
      status: models.Leave.status_approved(),
      employee_comment: 'Stage 6C sticky header layering fixture',
    });

    const capabilities = await driver.getCapabilities();
    browserName = capabilities.get('browserName');
    browserVersion = capabilities.get('browserVersion');
    await setViewport(driver, {width: 1024, height: 768});
    await openAndInflate(12);
  });

  after(async function() {
    if (driver) {
      await driver.quit();
      driver = null;
    }
    await new Promise(function(resolve) { setTimeout(resolve, 250); });
    const browserProcessCountAfter = browserProcessCount();
    expect(browserProcessCountAfter, 'suite must not leak Chrome/ChromeDriver processes')
      .to.be.at.most(browserProcessCountBefore);
    process.stdout.write(`\n[sticky-header] WebDriver closed; browser processes ${browserProcessCountBefore} -> ${browserProcessCountAfter}\n`);
  });

  it('reports the real browser, desktop viewport, and two real department tables', async function() {
    /*
      The viewport, not the window. These read window().getRect() and called it
      the viewport, which are different numbers: giving the page a 1024x768
      viewport takes a taller window than that, by however much chrome the host
      draws - 143px here. The window assertion passed while the page was 625px
      tall and the test said "desktop viewport" about it.
    */
    const viewport = await driver.executeScript(
      'return {width: window.innerWidth, height: window.innerHeight};'
    );
    expect(browserName).to.match(/^chrome/);
    expect(viewport).to.include({width: 1024, height: 768});
    expect((await driver.findElements(By.css('.team-view-table-shell'))).length).to.be.at.least(2);
    process.stdout.write(`\n[sticky-header] ${browserName} ${browserVersion}, viewport=${viewport.width}x${viewport.height}\n`);
  });

  it('preserves source semantics and starts with sanitised hidden overlays', async function() {
    const result = await driver.executeScript(function() {
      return Array.from(document.querySelectorAll('.team-view-table-shell')).map(function(shell) {
        const container = shell.querySelector('.team-view-table-container');
        const source = container.querySelector('.team-view-table:not(.team-view-sticky-header-table)');
        const overlay = shell.querySelector('.team-view-sticky-header');
        return {
          sourceFirst: shell.querySelector('table') === source,
          role: container.getAttribute('role'),
          tabIndex: container.getAttribute('tabindex'),
          caption: !!source.querySelector('caption'),
          thead: !!source.querySelector('thead'),
          scopes: source.querySelectorAll('th[scope]').length,
          sourceAriaHidden: source.querySelector('thead').getAttribute('aria-hidden'),
          overlayAriaHidden: overlay.getAttribute('aria-hidden'),
          overlayHidden: overlay.hidden,
          overlayRole: overlay.getAttribute('role'),
          overlayTabIndex: overlay.getAttribute('tabindex'),
          focusables: overlay.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex], [contenteditable]').length,
          ids: overlay.querySelectorAll('[id]').length,
          tbodies: overlay.querySelectorAll('tbody').length,
        };
      });
    });
    result.forEach(function(item) {
      expect(item).to.include({
        sourceFirst: true,
        role: 'region',
        tabIndex: '0',
        caption: true,
        thead: true,
        sourceAriaHidden: null,
        overlayAriaHidden: 'true',
        overlayHidden: true,
        overlayRole: null,
        overlayTabIndex: null,
        focusables: 0,
        ids: 0,
        tbodies: 0,
      });
      expect(item.scopes).to.be.greaterThan(1);
    });
  });

  it('activates exactly one correctly bounded fixed overlay', async function() {
    await scrollShellPastTop(0, 220);
    const value = await geometry(0);
    expect(value.activeOverlayCount).to.equal(1);
    expect(value.overlayHidden).to.equal(false);
    expect(value.position).to.equal('fixed');
    expect(value.overlayRect.top).to.be.closeTo(0, 1);
    expect(value.alignmentDeltas.overlayContainerLeft).to.be.closeTo(0, 1);
    expect(value.alignmentDeltas.overlayContainerWidth).to.be.closeTo(0, 1);
    expect(value.overlayRect.height).to.be.closeTo(value.sourceTheadRect.height, 1);
    expect(value.sourceTheadRect.top).to.be.lessThan(0);
    expect(value.sourceAriaHidden).to.equal(null);
    expect(value.sourceDepartmentText).to.equal(value.cloneDepartmentText);
    expect(value.sourceWeekdayText).to.deep.equal(value.cloneWeekdayText);
  });

  it('blocks click-through while document vertical scrolling remains available', async function() {
    await scrollShellPastTop(0, 220);
    await driver.executeScript(function() {
      window.__stage6cCoveredBodyClicks = 0;
      const button = document.querySelector('.team-view-table-shell tr:not([data-stage6c-test-clone]) .team-view-user-details-summary-trigger');
      button.addEventListener('click', function() { window.__stage6cCoveredBodyClicks += 1; });
    });
    const overlayHeader = await driver.findElement(By.css('.team-view-sticky-header:not([hidden]) th'));
    await driver.actions().move({origin: overlayHeader}).click().perform();
    expect(await driver.executeScript('return window.__stage6cCoveredBodyClicks;')).to.equal(0);
    const before = await driver.executeScript('return window.pageYOffset;');
    await driver.actions().scroll(0, 0, 0, 180).perform();
    await driver.sleep(100);
    const after = await driver.executeScript('return window.pageYOffset;');
    expect(after).to.be.greaterThan(before);
    expect(await activeOverlayCount()).to.equal(1);
  });

  it('keeps left, middle, and right horizontal geometry within 1.5 CSS px', async function() {
    await scrollShellPastTop(0, 220);
    for (const position of ['left', 'middle', 'right']) {
      const scroll = await setHorizontal(0, position);
      const value = await geometry(0);
      expect(scroll.maximum).to.be.greaterThan(0);
      expect(value.overlayScrollLeft).to.be.closeTo(value.sourceScrollLeft, 1);
      expect(value.alignmentDeltas.cloneSourceDate).to.be.closeTo(0, 1.5);
      expect(value.alignmentDeltas.sourceHeaderBodyDate).to.be.closeTo(0, 1.5);
      expect(value.alignmentDeltas.cloneNameDeductedRight).to.be.closeTo(0, 1.5);
      expect(value.cloneNameRect.left).to.be.closeTo(value.containerRect.left, 1.5);
      expect(value.viewportOverflowX).to.equal('hidden');
      expect(value.viewportOverflowY).to.equal('hidden');
      if (position === 'left') {
        expect(value.shellClasses).to.contain('can-scroll-right');
      } else if (position === 'right') {
        expect(
          value.shellClasses,
          'at the right edge, scroll metrics ' + JSON.stringify(value.scrollMetrics)
        ).to.not.contain('can-scroll-right');
        expect(value.shellClasses).to.contain('can-scroll-left');
      } else {
        expect(value.shellClasses).to.contain('can-scroll-right');
        expect(value.shellClasses).to.contain('can-scroll-left');
      }
    }
  });

  it('preserves source-container keyboard navigation and nested-control isolation', async function() {
    await scrollShellPastTop(0, 220);
    const container = (await driver.findElements(By.css('.team-view-table-container')))[0];
    await container.sendKeys(Key.NULL);
    for (const key of [Key.ARROW_RIGHT, Key.ARROW_LEFT, Key.END, Key.HOME]) {
      await container.sendKeys(key);
      await driver.sleep(80);
      const value = await geometry(0);
      expect(value.overlayScrollLeft).to.be.closeTo(value.sourceScrollLeft, 1);
      expect(await driver.executeScript(function(element) { return document.activeElement === element; }, container)).to.equal(true);
    }

    for (const selector of [
      '.team-view-employee-link',
      '.team-view-user-details-summary-trigger',
      '.team-view-deducted-days-trigger',
      '.team-view-leave-details-trigger',
    ]) {
      const nested = await driver.findElement(By.css(`.team-view-table-shell tr:not([data-stage6c-test-clone]) ${selector}`));
      await driver.executeScript(function() {
        window.__stage6cNestedPrevented = null;
        window.jQuery(document).one('keydown.stage6cStickyTest', function(event) {
          window.__stage6cNestedPrevented = event.isDefaultPrevented();
        });
      });
      await nested.sendKeys(Key.ARROW_RIGHT);
      await driver.sleep(60);
      expect(await driver.executeScript('return window.__stage6cNestedPrevented;')).to.equal(false);
      await nested.sendKeys(Key.ESCAPE);
    }
    expect(await driver.executeScript(function() {
      const overlay = document.querySelector('.team-view-sticky-header:not([hidden])');
      return overlay && overlay.contains(document.activeElement);
    })).to.equal(false);
  });

  it('keeps employee, deducted-days, and leave popovers above the active overlay', async function() {
    for (const selector of [
      '.team-view-user-details-summary-trigger',
      '.team-view-deducted-days-trigger',
      '.team-view-leave-details-trigger',
    ]) {
      await scrollShellPastTop(0, 220);
      const trigger = await driver.findElement(By.css(`.team-view-table-shell tr:not([data-stage6c-test-clone]) ${selector}`));
      await driver.executeScript(function(element) {
        element.scrollIntoView({block: 'center', inline: 'center'});
        element.focus();
      }, trigger);
      await waitPopoverVisible(trigger, true, selector);
      const layering = await driver.executeScript(function(element) {
        const id = element.getAttribute('aria-describedby');
        const tip = id && document.getElementById(id);
        const overlay = document.querySelector('.team-view-sticky-header:not([hidden])');
        return {
          tipVisible: !!(tip && tip.offsetParent !== null),
          tipZ: tip ? parseInt(getComputedStyle(tip).zIndex, 10) : 0,
          overlayZ: overlay ? parseInt(getComputedStyle(overlay).zIndex, 10) : 0,
          active: !!overlay,
        };
      }, trigger);
      expect(layering.tipVisible).to.equal(true);
      expect(layering.tipZ).to.be.greaterThan(layering.overlayZ);
      expect(layering.active).to.equal(true);
      await trigger.sendKeys(Key.ESCAPE);
      await waitPopoverVisible(trigger, false, selector);
      expect(await activeOverlayCount()).to.equal(1);
    }
    const cloneState = await driver.executeScript(function() {
      const overlay = document.querySelector('.team-view-sticky-header:not([hidden])');
      return {
        describedBy: overlay.querySelectorAll('[aria-describedby]').length,
        bootstrapData: Array.from(overlay.querySelectorAll('*')).filter(function(element) {
          return !!window.jQuery(element).data('bs.popover');
        }).length,
      };
    });
    expect(cloneState).to.deep.equal({describedBy: 0, bootstrapData: 0});
  });

  it('switches ownership between real tables without stale overlap', async function() {
    await scrollShellPastTop(0, 220);
    const first = await geometry(0);
    const gap = await driver.executeScript(function() {
      const shells = document.querySelectorAll('.team-view-table-shell');
      const firstBottom = shells[0].getBoundingClientRect().bottom + window.pageYOffset;
      const secondTop = shells[1].getBoundingClientRect().top + window.pageYOffset;
      return {firstBottom, secondTop, size: secondTop - firstBottom};
    });
    if (gap.size > 2) {
      await driver.executeScript(function(position) { window.scrollTo(0, position); }, gap.firstBottom + gap.size / 2);
      await driver.sleep(100);
      expect(await activeOverlayCount()).to.equal(0);
    } else {
      expect(gap.size).to.be.at.most(2);
    }
    await scrollShellPastTop(1, 120);
    const second = await geometry(1);
    const hiddenStates = await driver.executeScript(function() {
      return Array.from(document.querySelectorAll('.team-view-sticky-header')).map(function(item) { return item.hidden; });
    });
    expect(hiddenStates[0]).to.equal(true);
    expect(hiddenStates[1]).to.equal(false);
    expect(second.activeOverlayCount).to.equal(1);
    expect(second.cloneDepartmentText).to.equal(second.sourceDepartmentText);
    expect(second.cloneDepartmentText).to.not.equal(first.cloneDepartmentText);
  });

  it('remeasures cleanly from 1440 to 390 without page overflow', async function() {
    for (const viewport of [
      {width: 1440, height: 900},
      {width: 1024, height: 768},
      {width: 768, height: 900},
      {width: 390, height: 844},
    ]) {
      await setViewport(driver, viewport);
      await driver.executeScript('window.scrollTo(0, 0);');
      await driver.sleep(80);
      const pageOverflowBeforeSticky = await driver.executeScript(
        'return document.documentElement.scrollWidth - document.documentElement.clientWidth;'
      );
      await scrollShellPastTop(0, 220);
      await setHorizontal(0, 'middle');
      const value = await geometry(0);
      expect(value.activeOverlayCount).to.equal(1);
      expect(value.alignmentDeltas.overlayContainerLeft).to.be.closeTo(0, 1);
      expect(value.alignmentDeltas.overlayContainerWidth).to.be.closeTo(0, 1);
      expect(value.alignmentDeltas.cloneSourceDate).to.be.closeTo(0, 1.5);
      expect(value.overlayRect.left).to.be.at.least(-1);
      expect(value.overlayRect.right).to.be.at.most(viewport.width + 1);
      expect(value.pageOverflow).to.be.at.most(pageOverflowBeforeSticky + 1);
      expect(value.sourceScrollWidth).to.be.greaterThan(value.sourceClientWidth);
    }
  });

  it('captures the required viewport, theme, months, horizontal, and boundary matrix', async function() {
    visualManifest = [];
    const cases = [
      {name: '1440-light-1-start-left', width: 1440, height: 900, theme: 'light', months: 1, vertical: 'start', horizontal: 'left'},
      {name: '1440-dark-6-middle-middle', width: 1440, height: 900, theme: 'dark', months: 6, vertical: 'middle', horizontal: 'middle'},
      {name: '1024-light-12-middle-right', width: 1024, height: 768, theme: 'light', months: 12, vertical: 'middle', horizontal: 'right'},
      {name: '1024-dark-6-transition-left', width: 1024, height: 768, theme: 'dark', months: 6, vertical: 'transition', horizontal: 'left'},
      {name: '768-light-6-bottom-middle', width: 768, height: 900, theme: 'light', months: 6, vertical: 'bottom', horizontal: 'middle'},
      {name: '390-light-12-middle-middle', width: 390, height: 844, theme: 'light', months: 12, vertical: 'middle', horizontal: 'middle'},
      {name: '390-dark-1-transition-right', width: 390, height: 844, theme: 'dark', months: 1, vertical: 'transition', horizontal: 'right'},
    ];
    for (const testCase of cases) { await captureVisualCase(testCase); }
    fs.writeFileSync(
      path.join(artifactDirectory, 'manifest.json'),
      `${JSON.stringify(visualManifest, null, 2)}\n`,
      'utf8'
    );
    expect(visualManifest).to.have.length(7);
    expect(new Set(visualManifest.map(function(item) { return `${item.viewport.width}x${item.viewport.height}`; })).size).to.equal(4);
    expect(new Set(visualManifest.map(function(item) { return item.theme; }))).to.deep.equal(new Set(['light', 'dark']));
    expect(new Set(visualManifest.map(function(item) { return item.months; }))).to.deep.equal(new Set([1, 6, 12]));
    expect(new Set(visualManifest.map(function(item) { return item.horizontal; }))).to.deep.equal(new Set(['left', 'middle', 'right']));
    expect(new Set(visualManifest.map(function(item) { return item.vertical; }))).to.deep.equal(new Set(['start', 'middle', 'transition', 'bottom']));
    process.stdout.write(`\n[sticky-header] visual matrix: ${visualManifest.length} screenshots in ${artifactDirectory}\n`);
  });

  it('verifies mobile wheel/pointer input without CDP touch emulation', async function() {
    await setViewport(driver, {width: 390, height: 844});
    await openAndInflate(12);
    await applyTheme('light');
    await driver.executeScript(function() {
      const shell = document.querySelector('.team-view-table-shell');
      window.scrollTo(0, shell.getBoundingClientRect().top + window.pageYOffset);
    });
    const pageBefore = await driver.executeScript('return window.pageYOffset;');
    await driver.actions().scroll(0, 0, 0, 240).perform();
    await driver.wait(async function() { return (await activeOverlayCount()) === 1; }, 2000);
    const pageAfter = await driver.executeScript('return window.pageYOffset;');
    expect(pageAfter).to.be.greaterThan(pageBefore);

    const container = (await driver.findElements(By.css('.team-view-table-container')))[0];
    await driver.actions().scroll(0, 0, 260, 0, container).perform();
    await driver.sleep(120);
    const value = await geometry(0);
    expect(value.sourceScrollLeft).to.be.greaterThan(0);
    expect(value.overlayScrollLeft).to.be.closeTo(value.sourceScrollLeft, 1);
    expect(value.cloneNameRect.left).to.be.closeTo(value.containerRect.left, 1.5);
    expect(value.pageOverflow).to.be.at.most(1);

    await driver.executeScript(function() {
      window.__stage6cMobileCoveredClicks = 0;
      document.querySelector('tr:not([data-stage6c-test-clone]) .team-view-user-details-summary-trigger')
        .addEventListener('click', function() { window.__stage6cMobileCoveredClicks += 1; });
    });
    const overlayHeader = await driver.findElement(By.css('.team-view-sticky-header:not([hidden]) th'));
    await driver.actions().move({origin: overlayHeader}).click().perform();
    expect(await driver.executeScript('return window.__stage6cMobileCoveredClicks;')).to.equal(0);

    const deducted = await driver.findElement(By.css('tr:not([data-stage6c-test-clone]) .team-view-deducted-days-trigger'));
    await driver.executeScript(function(element) { element.scrollIntoView({block: 'center'}); }, deducted);
    await driver.actions().move({origin: deducted}).click().perform();
    await waitExpanded(deducted, true);
    await deducted.sendKeys(Key.ESCAPE);
    await waitExpanded(deducted, false);
    process.stdout.write('\n[sticky-header] mobile verified with real Selenium wheel/pointer operations at 390x844; CDP touch emulation not used; VoiceOver manual listening not performed (UI-scripting permission unavailable)\n');
  });
});
