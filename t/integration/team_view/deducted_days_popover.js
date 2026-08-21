'use strict';

const config = require('../../lib/config');
const models = require('../../../lib/model/db');
const dayjs = require('../../../lib/util/date');
const fs = require('fs');
const path = require('path');
const By = require('selenium-webdriver').By;
const Key = require('selenium-webdriver').Key;
const until = require('selenium-webdriver').until;
const expect = require('chai').expect;

const registerNewUser = require('../../lib/register_new_user');
const addNewUser = require('../../lib/add_new_user');
const openPage = require('../../lib/open_page');
const setViewport = require('../../lib/set_viewport');

describe('Interactive Team View deducted-days popover', function() {
  this.timeout(config.get_execution_timeout());

  const applicationHost = config.get_application_host();
  const employeeEmail = `deducted-popover-${Date.now()}@test.com`;
  let driver;
  let admin;
  let employee;

  after(async function() {
    if (driver) {
      await driver.quit();
      driver = null;
      process.stdout.write('\n[deducted-popover] WebDriver closed after suite\n');
    }
  });

  async function openTeamView(months) {
    await openPage({
      url: `${applicationHost}calendar/teamview/?months=${months || 6}`,
      driver,
    });
    await driver.wait(
      until.elementsLocated(By.css('.interactive-teamview-deducted-days-trigger')),
      5000
    );
  }

  async function buttons() {
    return driver.findElements(By.css('.interactive-teamview-deducted-days-trigger'));
  }

  async function buttonAt(index) {
    const found = await buttons();
    expect(found.length, 'expected at least two authorized deducted triggers').to.be.at.least(2);
    return found[index];
  }

  async function triggerVisible(trigger) {
    return driver.executeScript(function(element) {
      const instance = window.jQuery(element).data('bs.popover');
      const tip = instance && instance.tip();
      return !!(tip && tip.is(':visible'));
    }, trigger);
  }

  async function waitVisible(trigger, expected, timeout) {
    await driver.wait(async function() {
      return (await triggerVisible(trigger)) === expected;
    }, timeout || 2000);
  }

  async function waitExpanded(trigger, expected, timeout) {
    await driver.wait(async function() {
      return (await trigger.getAttribute('aria-expanded')) === String(expected);
    }, timeout || 2000);
  }

  async function visibleCount() {
    return driver.executeScript(function() {
      let count = 0;
      document.querySelectorAll('.interactive-teamview-deducted-days-trigger')
        .forEach(function(trigger) {
          const instance = window.jQuery(trigger).data('bs.popover');
          const tip = instance && instance.tip();
          if (tip && tip.is(':visible')) {
            count += 1;
          }
        });
      return count;
    });
  }

  async function waitForScrollToSettle(container) {
    let previous = await driver.executeScript(function(element) {
      return element.scrollLeft;
    }, container);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await driver.sleep(100);
      const current = await driver.executeScript(function(element) {
        return element.scrollLeft;
      }, container);
      if (current === previous) {
        return current;
      }
      previous = current;
    }
    return previous;
  }

  async function info(trigger) {
    return driver.executeScript(function(element) {
      const id = element.getAttribute('aria-describedby') || '';
      const tip = id ? document.getElementById(id) : null;
      return {
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type'),
        label: element.getAttribute('aria-label') || '',
        content: element.getAttribute('data-content') || '',
        visible: (element.textContent || '').trim(),
        expanded: element.getAttribute('aria-expanded'),
        describedBy: id,
        tipVisible: !!(tip && tip.offsetParent !== null),
        role: tip ? tip.getAttribute('role') : null,
        tipText: tip ? (tip.textContent || '').trim() : '',
      };
    }, trigger);
  }

  async function moveToOutsideAndClick() {
    const heading = await driver.findElement(By.css('h1'));
    await driver.actions().move({origin: heading}).click().perform();
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

  async function captureScreenshot(directory, name) {
    const image = await driver.takeScreenshot();
    fs.writeFileSync(path.join(directory, `${name}.png`), image, 'base64');
  }

  async function fractionalTrigger() {
    const found = await buttons();
    for (const trigger of found) {
      if ((await trigger.getText()).trim() === '1.5') {
        return trigger;
      }
    }
    throw new Error('Expected a deducted-days trigger with exact value 1.5');
  }

  it('creates a company with two authorized Team View rows', async function() {
    this.timeout(config.get_execution_timeout() * 3);
    const registration = await registerNewUser({application_host: applicationHost});
    driver = registration.driver;
    await addNewUser({
      driver,
      application_host: applicationHost,
      email: employeeEmail,
    });
    admin = await models.User.findOne({where: {email: registration.email}});
    employee = await models.User.findOne({where: {email: employeeEmail}});
    const leaveType = await models.LeaveType.findOne({where: {companyId: admin.companyId}});
    let start = dayjs.utc().startOf('month');
    while (start.isoWeekday() !== 1) {
      start = start.add(1, 'day');
    }
    const end = start.clone().add(1, 'day');

    await employee.update({
      name: 'Alexandria-Cassandra-With-An-Exceptionally-Long-Name',
      lastname: 'Montgomery-Worthington',
    });
    await models.Leave.create({
      userId: employee.id,
      approverId: admin.id,
      leaveTypeId: leaveType.id,
      date_start: start.format('YYYY-MM-DD'),
      date_end: end.format('YYYY-MM-DD'),
      day_part_start: models.Leave.leave_day_part_morning(),
      day_part_end: models.Leave.leave_day_part_all(),
      status: models.Leave.status_approved(),
      employee_comment: 'Stage 6B fractional deducted-days fixture',
    });
    await openTeamView(6);
    expect((await buttons()).length).to.be.at.least(2);
    expect(await (await fractionalTrigger()).getText()).to.equal('1.5');
  });

  it('reports the real browser and desktop viewport used by the suite', async function() {
    const capabilities = await driver.getCapabilities();
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
    const browserName = capabilities.get('browserName');
    const browserVersion = capabilities.get('browserVersion');

    expect(browserName).to.match(/^chrome/);
    expect(viewport.width).to.equal(1024);
    expect(viewport.height).to.equal(768);
    process.stdout.write(
      `\n[deducted-popover] ${browserName} ${browserVersion}, `
      + `headless=${!process.env.SHOW_CHROME}, viewport=${viewport.width}x${viewport.height}\n`
    );
  });

  it('renders native buttons with matching employee, period, and exact days text', async function() {
    const trigger = await buttonAt(0);
    const row = await trigger.findElement(By.xpath('./ancestor::tr'));
    const employeeName = (
      await row.findElement(By.css('.team-view-employee-link, .team-view-employee-name')).getText()
    ).trim();
    const details = await info(trigger);

    expect(details.tag).to.equal('button');
    expect(details.type).to.equal('button');
    expect(details.visible).to.match(/^\d+(?:\.\d+)?$/);
    expect(details.content).to.equal(details.label);
    expect(details.content).to.contain(employeeName);
    expect(details.content).to.contain(details.visible);
    expect(details.content).to.match(/[A-Z][a-z]{2,8}(?:\s*-\s*[A-Z][a-z]{2,8})?, \d{4}/);
    expect(details.expanded).to.equal('false');
    expect(details.describedBy).to.equal('');
  });

  it('native WebDriver keyboard focus opens immediately with tooltip ARIA', async function() {
    const trigger = await buttonAt(0);
    await trigger.sendKeys(Key.NULL);
    await waitVisible(trigger, true, 1500);
    await waitExpanded(trigger, true);
    const details = await info(trigger);

    expect(details.expanded).to.equal('true');
    expect(details.describedBy).to.not.equal('');
    expect(details.tipVisible).to.equal(true);
    expect(details.role).to.equal('tooltip');
    expect(details.tipText).to.equal(details.content);
  });

  it('Escape closes without moving focus, then Enter reopens', async function() {
    const trigger = await buttonAt(0);
    await trigger.sendKeys(Key.ESCAPE);
    await waitVisible(trigger, false);
    await waitExpanded(trigger, false);
    expect(await driver.executeScript(
      function(element) { return document.activeElement === element; },
      trigger
    )).to.equal(true);
    expect((await info(trigger)).describedBy).to.equal('');

    await trigger.sendKeys(Key.ENTER);
    await waitVisible(trigger, true);
    await waitExpanded(trigger, true);
    expect((await info(trigger)).expanded).to.equal('true');
  });

  it('Space reopens after Escape and does not close an already focused popover', async function() {
    const trigger = await buttonAt(0);
    await trigger.sendKeys(Key.ESCAPE);
    await waitVisible(trigger, false);
    await trigger.sendKeys(Key.SPACE);
    await waitVisible(trigger, true);
    await waitExpanded(trigger, true);
    await trigger.sendKeys(Key.SPACE);
    await driver.sleep(180);
    expect(await triggerVisible(trigger)).to.equal(true);
  });

  it('Tab away closes the focus-opened popover after the hide delay', async function() {
    const trigger = await buttonAt(0);
    await trigger.sendKeys(Key.TAB);
    await waitVisible(trigger, false);
    await waitExpanded(trigger, false);
    expect((await info(trigger)).expanded).to.equal('false');
  });

  it('short hover stays closed and sustained real pointer hover opens', async function() {
    await openTeamView(6);
    const trigger = await buttonAt(0);
    const heading = await driver.findElement(By.css('h1'));
    await driver.actions().move({origin: trigger}).perform();
    await driver.sleep(300);
    expect(await triggerVisible(trigger), 'under 700ms must stay closed').to.equal(false);
    await driver.actions().move({origin: heading}).perform();
    await driver.sleep(160);

    await driver.actions().move({origin: trigger}).perform();
    await driver.sleep(760);
    expect(await triggerVisible(trigger), 'over 700ms opens').to.equal(true);
  });

  it('real pointer transfer to the Bootstrap tip keeps it open, then leaving both closes', async function() {
    const trigger = await buttonAt(0);
    const tip = await driver.findElement(By.css('.popover.in[role="tooltip"]'));
    const heading = await driver.findElement(By.css('h1'));
    await driver.actions().move({origin: tip}).perform();
    await driver.sleep(220);
    expect(await triggerVisible(trigger)).to.equal(true);
    await driver.actions().move({origin: heading}).perform();
    await waitVisible(trigger, false);
  });

  it('real WebElement clicks open and close the same trigger', async function() {
    await openTeamView(6);
    const trigger = await buttonAt(0);
    await trigger.click();
    await waitVisible(trigger, true);
    await trigger.click();
    await waitVisible(trigger, false);
  });

  it('real outside click closes while a real inside-tip click preserves the popover', async function() {
    let trigger = await buttonAt(0);
    await trigger.click();
    await waitVisible(trigger, true);
    let tip = await driver.findElement(By.css('.popover.in .popover-content'));
    await driver.actions().move({origin: tip}).click().perform();
    await driver.sleep(220);
    expect(await triggerVisible(trigger), 'inside click must preserve').to.equal(true);
    await moveToOutsideAndClick();
    await waitVisible(trigger, false);

    trigger = await buttonAt(0);
    await trigger.click();
    await waitVisible(trigger, true);
    await moveToOutsideAndClick();
    await waitVisible(trigger, false);
  });

  it('opening B closes A and keeps exactly one deducted popover visible', async function() {
    await openTeamView(6);
    const first = await buttonAt(0);
    const second = await buttonAt(1);
    await first.click();
    await waitVisible(first, true);
    await second.click();
    await waitVisible(first, false);
    await waitVisible(second, true);
    expect(await visibleCount()).to.equal(1);
  });

  it('opening B cancels a pending hover for A so A cannot reopen late', async function() {
    await openTeamView(6);
    const first = await buttonAt(0);
    const second = await buttonAt(1);
    await driver.actions().move({origin: first}).perform();
    await driver.sleep(300);
    await second.click();
    await waitVisible(second, true);
    await driver.sleep(520);
    expect(await triggerVisible(first)).to.equal(false);
    expect(await triggerVisible(second)).to.equal(true);
    expect(await visibleCount()).to.equal(1);
  });

  it('nested button keyboard input does not move the table scroll position', async function() {
    await openTeamView(12);
    const container = await driver.findElement(By.css('.team-view-table-container'));
    const trigger = await buttonAt(0);
    await driver.executeScript(function(element) {
      element.scrollLeft = Math.min(120, element.scrollWidth - element.clientWidth);
    }, container);
    const before = await driver.executeScript(function(element) {
      return element.scrollLeft;
    }, container);
    await trigger.sendKeys(Key.NULL);
    await waitVisible(trigger, true);
    await trigger.sendKeys(Key.ESCAPE);
    await waitVisible(trigger, false);
    await driver.executeScript(function() {
      window.__deductedArrowDefaultPrevented = null;
      window.jQuery(document).one('keydown.deductedArrowTest', function(e) {
        window.__deductedArrowDefaultPrevented = e.isDefaultPrevented();
      });
    });
    await trigger.sendKeys(Key.ARROW_RIGHT);
    await driver.sleep(120);
    const afterArrow = await driver.executeScript(function(element) {
      return element.scrollLeft;
    }, container);
    const navigationEvidence = await driver.executeScript(function(element) {
      const evidence = {
        defaultPrevented: window.__deductedArrowDefaultPrevented,
        activeIsTrigger: document.activeElement === element,
      };
      window.jQuery(document).off('keydown.deductedArrowTest');
      delete window.__deductedArrowDefaultPrevented;
      return evidence;
    }, trigger);
    expect(navigationEvidence.defaultPrevented).to.equal(false);
    expect(navigationEvidence.activeIsTrigger).to.equal(true);
    expect(afterArrow).to.be.at.least(before);

    const settledAfterArrow = await waitForScrollToSettle(container);
    await trigger.sendKeys(Key.ENTER);
    await waitVisible(trigger, true);
    await waitExpanded(trigger, true);
    const afterEnter = await driver.executeScript(function(element) {
      return element.scrollLeft;
    }, container);
    expect(afterEnter).to.equal(settledAfterArrow);
  });

  it('remains sticky, visible, and operable after horizontal Team View scroll', async function() {
    const container = await driver.findElement(By.css('.team-view-table-container'));
    await driver.executeScript(function(element) {
      element.scrollLeft = element.scrollWidth;
    }, container);
    const trigger = await buttonAt(0);
    const geometry = await driver.executeScript(function(element) {
      const cell = element.closest('.team-view-deducted-cell');
      const rect = element.getBoundingClientRect();
      return {
        sticky: getComputedStyle(cell).position,
        left: rect.left,
        right: rect.right,
        viewport: window.innerWidth,
      };
    }, trigger);
    expect(geometry.sticky).to.equal('sticky');
    expect(geometry.left).to.be.at.least(0);
    expect(geometry.right).to.be.at.most(geometry.viewport);

    await trigger.sendKeys(Key.ESCAPE);
    await waitVisible(trigger, false);
    await trigger.sendKeys(Key.ENTER);
    await waitVisible(trigger, true);
    await waitExpanded(trigger, true);
  });

  it('captures the required responsive/theme/month matrix with geometry evidence', async function() {
    this.timeout(config.get_execution_timeout() * 5);
    const directory = '/tmp/timeoff-stage6b-deducted-days';
    const viewports = [
      {width: 1440, height: 900, theme: 'light'},
      {width: 1440, height: 900, theme: 'dark'},
      {width: 1024, height: 768, theme: 'light'},
      {width: 768, height: 900, theme: 'light'},
      {width: 390, height: 844, theme: 'light'},
      {width: 390, height: 844, theme: 'dark'},
    ];
    const monthCounts = [1, 6, 12];
    const manifest = [];
    fs.mkdirSync(directory, {recursive: true});

    for (const viewport of viewports) {
      await setViewport(driver, {
        width: viewport.width,
        height: viewport.height,
      });
      for (const months of monthCounts) {
        await openTeamView(months);
        await applyTheme(viewport.theme);
        const trigger = await fractionalTrigger();
        const before = await driver.executeScript(function(element) {
          const row = element.closest('tr');
          const cell = element.closest('td');
          return {
            rowHeight: row.getBoundingClientRect().height,
            cellWidth: cell.getBoundingClientRect().width,
          };
        }, trigger);
        await trigger.sendKeys(Key.NULL);
        await waitVisible(trigger, true);
        await waitExpanded(trigger, true);

        const measurement = await driver.executeScript(function(element, monthCount) {
          function parseColor(value) {
            const channels = value.match(/[\d.]+/g).map(Number);
            return channels.slice(0, 3);
          }
          function luminance(channels) {
            const normalized = channels.map(function(channel) {
              const value = channel / 255;
              return value <= 0.03928
                ? value / 12.92
                : Math.pow((value + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * normalized[0] + 0.7152 * normalized[1] + 0.0722 * normalized[2];
          }
          const row = element.closest('tr');
          const cell = element.closest('td');
          const container = element.closest('.team-view-table-container');
          const id = element.getAttribute('aria-describedby') || '';
          const tip = id ? document.getElementById(id) : null;
          const popoverContent = tip ? tip.querySelector('.popover-content') : null;
          const triggerRect = element.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          const cellRect = cell.getBoundingClientRect();
          const tipRect = tip ? tip.getBoundingClientRect() : null;
          const triggerStyle = getComputedStyle(element);
          const cellStyle = getComputedStyle(cell);
          const foreground = luminance(parseColor(triggerStyle.color));
          const background = luminance(parseColor(triggerStyle.backgroundColor));
          const contrast = (Math.max(foreground, background) + 0.05)
            / (Math.min(foreground, background) + 0.05);
          const outlineExtent = parseFloat(triggerStyle.outlineWidth || '0')
            + parseFloat(triggerStyle.outlineOffset || '0');
          return {
            months: monthCount,
            triggerWidth: triggerRect.width,
            triggerHeight: triggerRect.height,
            rowHeight: rowRect.height,
            cellWidth: cellRect.width,
            popoverBounds: tipRect ? {
              left: tipRect.left,
              right: tipRect.right,
              top: tipRect.top,
              bottom: tipRect.bottom,
            } : null,
            popoverWithinViewport: !!(tipRect
              && tipRect.left >= -1
              && tipRect.right <= window.innerWidth + 1
              && tipRect.top >= -1
              && tipRect.bottom <= window.innerHeight + 1),
            pageOverflow: document.documentElement.scrollWidth
              - document.documentElement.clientWidth,
            tableOverflow: container.scrollWidth - container.clientWidth,
            stickyPosition: cellStyle.position,
            visibleText: (element.textContent || '').trim(),
            accessibleName: element.getAttribute('aria-label') || '',
            expanded: element.getAttribute('aria-expanded'),
            describedBy: id,
            outlineWidth: triggerStyle.outlineWidth,
            outlineStyle: triggerStyle.outlineStyle,
            focusRingClipped: cellStyle.overflow !== 'visible' && (
              triggerRect.left - outlineExtent < cellRect.left
              || triggerRect.right + outlineExtent > cellRect.right
            ),
            contrastRatio: contrast,
            contentWraps: popoverContent
              ? popoverContent.scrollHeight > parseFloat(getComputedStyle(popoverContent).fontSize) * 2.5
              : false,
            contentFitsWidth: popoverContent
              ? popoverContent.scrollWidth <= popoverContent.clientWidth + 1
              : false,
          };
        }, trigger, months);

        expect(measurement.triggerWidth).to.be.at.least(24);
        expect(measurement.triggerHeight).to.be.at.least(24);
        expect(measurement.popoverWithinViewport).to.equal(true);
        expect(measurement.pageOverflow).to.be.at.most(1);
        expect(measurement.stickyPosition).to.equal('sticky');
        expect(measurement.visibleText).to.equal('1.5');
        expect(measurement.accessibleName).to.contain('1.5');
        expect(measurement.accessibleName).to.contain('Alexandria-Cassandra');
        expect(measurement.expanded).to.equal('true');
        expect(measurement.describedBy).to.not.equal('');
        expect(measurement.outlineWidth).to.not.equal('0px');
        expect(measurement.outlineStyle).not.to.equal('none');
        expect(measurement.focusRingClipped).to.equal(false);
        expect(measurement.contrastRatio).to.be.at.least(4.5);
        expect(measurement.contentWraps).to.equal(true);
        expect(measurement.contentFitsWidth).to.equal(true);
        expect(Math.abs(measurement.rowHeight - before.rowHeight)).to.be.at.most(1);
        expect(Math.abs(measurement.cellWidth - before.cellWidth)).to.be.at.most(1);
        if (months === 12 && viewport.width <= 768) {
          expect(measurement.tableOverflow).to.be.greaterThan(0);
        }

        const name = `team-view-${months}m-${viewport.width}x${viewport.height}-${viewport.theme}`;
        await captureScreenshot(directory, name);
        manifest.push(Object.assign({
          file: `${name}.png`,
          viewport: {
            width: viewport.width,
            height: viewport.height,
          },
          theme: viewport.theme,
        }, measurement));
        await trigger.sendKeys(Key.ESCAPE);
        await waitVisible(trigger, false);
      }
    }

    fs.writeFileSync(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );
    expect(manifest).to.have.length(18);
    expect(new Set(manifest.map(function(item) {
      return `${item.viewport.width}x${item.viewport.height}-${item.theme}-${item.months}`;
    })).size).to.equal(18);
    process.stdout.write(
      `\n[deducted-popover] visual matrix: ${manifest.length} entries in ${directory}\n`
    );
  });

  it('validates mobile pointer toggle, outside close, and both scroll regions', async function() {
    await setViewport(driver, {width: 390, height: 844});
    await openTeamView(12);
    await applyTheme('light');
    const trigger = await fractionalTrigger();
    await trigger.click();
    await waitVisible(trigger, true);
    await trigger.click();
    await waitVisible(trigger, false);
    await trigger.click();
    await waitVisible(trigger, true);
    await moveToOutsideAndClick();
    await waitVisible(trigger, false);

    const scrollEvidence = await driver.executeScript(function() {
      const container = document.querySelector('.team-view-table-container');
      const initialPageY = window.pageYOffset;
      window.scrollTo(0, Math.min(120, document.documentElement.scrollHeight - window.innerHeight));
      const pageY = window.pageYOffset;
      const initialTableX = container.scrollLeft;
      container.scrollLeft = Math.min(160, container.scrollWidth - container.clientWidth);
      return {
        initialPageY,
        pageY,
        initialTableX,
        tableX: container.scrollLeft,
        tableOverflow: container.scrollWidth - container.clientWidth,
      };
    });
    expect(scrollEvidence.tableOverflow).to.be.greaterThan(0);
    expect(scrollEvidence.tableX).to.be.greaterThan(scrollEvidence.initialTableX);
    expect(scrollEvidence.pageY).to.be.at.least(scrollEvidence.initialPageY);
    process.stdout.write(
      '\n[deducted-popover] mobile input: real Selenium pointer operations at 390x844; '
      + 'CDP touch emulation not used\n'
    );
  });
});
