'use strict';

var config           = require('../../lib/config'),
    application_host = config.get_application_host(),
    By               = require('selenium-webdriver').By,
    Key              = require('selenium-webdriver').Key,
    until            = require('selenium-webdriver').until,
    expect           = require('chai').expect,

    register_new_user_func = require('../../lib/register_new_user'),
    add_new_user_func      = require('../../lib/add_new_user'),
    open_page_func         = require('../../lib/open_page');

describe('Team View employee summary popover (separated trigger)', function(){

  this.timeout( config.get_execution_timeout() );

  var driver;
  var adminEmail;
  var employeeEmail = 'employee_' + Date.now() + '@test.com';

  function buttonAt(idx) {
    return driver.findElements(By.css('.team-view-user-details-summary-trigger'))
      .then(function(els){ return els[idx]; });
  }
  function buttonCount() {
    return driver.findElements(By.css('.team-view-user-details-summary-trigger'))
      .then(function(els){ return els.length; });
  }
  function isVisibleViaState(idx) {
    return driver.executeScript(function(i){
      var triggers = document.querySelectorAll('.team-view-user-details-summary-trigger');
      var t = triggers[i];
      if (!t) { return false; }
      var inst = window.jQuery(t).data('bs.popover');
      var tip = inst && inst.tip();
      return !!(tip && tip.is(':visible'));
    }, idx);
  }
  function describedBy(idx) {
    return driver.executeScript(function(i){
      var t = document.querySelectorAll('.team-view-user-details-summary-trigger')[i];
      return t ? (t.getAttribute('aria-describedby') || '') : '';
    }, idx);
  }
  function visibleTeamViewPopoverCount() {
    return driver.executeScript(function(){
      var triggers = document.querySelectorAll('.team-view-user-details-summary-trigger');
      var n = 0;
      for (var i = 0; i < triggers.length; i++) {
        var inst = window.jQuery(triggers[i]).data('bs.popover');
        var tip = inst && inst.tip();
        if (tip && tip.is(':visible')) { n++; }
      }
      return n;
    });
  }

  it('Registers a new company (admin) and adds an employee', function(done){
    register_new_user_func({ application_host: application_host })
      .then(function(data){
        driver = data.driver;
        adminEmail = data.email;
      })
      .then(function(){
        return add_new_user_func({
          driver: driver, application_host: application_host, email: employeeEmail,
        });
      })
      .then(function(){ done() })
      .catch(done);
  });

  it('Opens Team View with at least two employee rows', function(done){
    open_page_func({ url: application_host + 'calendar/teamview/', driver: driver })
      .then(function(){ return driver.wait(until.elementLocated(By.css('.team-view-table')), 5000); })
      .then(function(){ return buttonCount(); })
      .then(function(n){
        // admin + employee = 2 rows with summary buttons
        expect(n, 'expected at least two Team View summary buttons').to.be.at.least(2);
      })
      .then(function(){ done() })
      .catch(done);
  });

  it('Employee cell contains a separate admin edit link and summary button', function(done){
    driver.executeScript(function(){
      var cells = document.querySelectorAll('.team-view-employee-cell');
      if (!cells.length) { return {found: false}; }
      var cell = cells[0];
      return {
        found: true,
        hasCell: true,
        hasButton: !!cell.querySelector('button.team-view-user-details-summary-trigger'),
        hasAdminLink: !!cell.querySelector('a.team-view-employee-link[href*="/users/edit/"]'),
        buttonIsButton: cell.querySelector('.team-view-user-details-summary-trigger').tagName.toLowerCase() === 'button',
        tdHasTriggerClass: cell.parentElement.classList.contains('user-details-summary-trigger')
      };
    })
      .then(function(info){
        expect(info.found).to.equal(true);
        expect(info.hasButton).to.equal(true);
        expect(info.hasAdminLink).to.equal(true);
        expect(info.buttonIsButton).to.equal(true);
        expect(info.tdHasTriggerClass, 'td must not carry user-details-summary-trigger').to.equal(false);
      })
      .then(function(){ done() })
      .catch(done);
  });

  it('The <td> itself has no Bootstrap popover instance', function(done){
    driver.executeScript(function(){
      var td = document.querySelector('.team-view-table .left-column-cell.cross-link');
      return td ? !!window.jQuery(td).data('bs.popover') : null;
    })
      .then(function(hasPopover){
        expect(hasPopover, 'td must not have a popover instance').to.equal(false);
      })
      .then(function(){ done() })
      .catch(done);
  });

  it('The summary button has a manual Bootstrap popover', function(done){
    driver.executeScript(function(){
      var btn = document.querySelector('.team-view-user-details-summary-trigger');
      var inst = btn && window.jQuery(btn).data('bs.popover');
      return inst ? inst.options.trigger : null;
    })
      .then(function(triggerOpt){
        expect(triggerOpt, 'button popover must be manual').to.equal('manual');
      })
      .then(function(){ done() })
      .catch(done);
  });

  it('Keyboard focus shows the popover immediately', function(done){
    driver.executeScript(function(){
      document.querySelectorAll('.team-view-user-details-summary-trigger')[0].focus();
    })
      .then(function(){ return driver.wait(function(){ return isVisibleViaState(0); }, 1500); })
      .then(function(){ done() })
      .catch(done);
  });

  it('aria-describedby points at a visible .popover[role=tooltip]', function(done){
    driver.executeScript(function(){
      var t = document.querySelectorAll('.team-view-user-details-summary-trigger')[0];
      var id = t.getAttribute('aria-describedby') || '';
      var pop = id ? document.getElementById(id) : null;
      return { id: id, exists: !!pop, role: pop ? pop.getAttribute('role') : null };
    })
      .then(function(info){
        expect(info.id.length).to.be.greaterThan(0);
        expect(info.exists).to.equal(true);
        expect(info.role).to.equal('tooltip');
      })
      .then(function(){ done() })
      .catch(done);
  });

  it('Replaces AJAX loading text with real summary content', function(done){
    driver.wait(function(){
        return driver.executeScript(function(){
          var t = document.querySelectorAll('.team-view-user-details-summary-trigger')[0];
          var id = t.getAttribute('aria-describedby') || '';
          var pop = id ? document.getElementById(id) : null;
          if (!pop) { return false; }
          var txt = (pop.textContent || '').trim();
          return txt.length > 0 && !/loading/i.test(txt);
        });
      }, 4000)
      .then(function(){ done() })
      .catch(done);
  });

  it('Escape closes the popover and leaves focus on the button', function(done){
    driver.switchTo().activeElement()
      .then(function(el){ return el.sendKeys(Key.ESCAPE); })
      .then(function(){ return driver.sleep(250); })
      .then(function(){ return isVisibleViaState(0); })
      .then(function(v){ expect(v).to.equal(false); })
      .then(function(){
        return driver.executeScript(function(){
          var t = document.querySelectorAll('.team-view-user-details-summary-trigger')[0];
          return document.activeElement === t;
        });
      })
      .then(function(onBtn){ expect(onBtn).to.equal(true); })
      .then(function(){ done() })
      .catch(done);
  });

  it('Enter re-opens the popover after Escape', function(done){
    driver.switchTo().activeElement()
      .then(function(el){ return el.sendKeys(Key.ENTER); })
      .then(function(){ return driver.sleep(200); })
      .then(function(){ return isVisibleViaState(0); })
      .then(function(v){ expect(v, 'popover should re-open on Enter').to.equal(true); })
      .then(function(){ done() })
      .catch(done);
  });

  it('A real Selenium click on the button opens then closes the popover', function(done){
    // Reload for a clean controller state before the pointer scenario.
    open_page_func({ url: application_host + 'calendar/teamview/', driver: driver })
      .then(function(){ return driver.sleep(200); })
      .then(function(){ return buttonAt(0); })
      .then(function(btn){
        return driver.executeScript('document.body.focus();')
          .then(function(){ return driver.sleep(100); })
          .then(function(){ return btn.click(); });
      })
      .then(function(){ return driver.sleep(250); })
      .then(function(){ return isVisibleViaState(0); })
      .then(function(v){ expect(v, 'first click opens').to.equal(true); })
      // Second click via dispatched MouseEvent: once the popover is open it can
      // overlap the trigger, and a native Selenium click on the underlying
      // button would be intercepted. Dispatching the event reaches the button
      // regardless of the popover layer.
      .then(function(){
        return driver.executeScript(function(){
          var el = document.querySelectorAll('.team-view-user-details-summary-trigger')[0];
          el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, detail: 1}));
        });
      })
      .then(function(){ return driver.sleep(250); })
      .then(function(){ return isVisibleViaState(0); })
      .then(function(v){ expect(v, 'second click closes').to.equal(false); })
      .then(function(){ done() })
      .catch(done);
  });

  it('Click outside closes a pinned popover', function(done){
    buttonAt(0)
      .then(function(btn){
        return driver.executeScript('document.body.focus();')
          .then(function(){ return driver.sleep(100); })
          .then(function(){ return btn.click(); });
      })
      .then(function(){ return driver.sleep(250); })
      .then(function(){
        return driver.executeScript(function(){
          document.body.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, detail: 1}));
        });
      })
      .then(function(){ return driver.sleep(250); })
      .then(function(){ return isVisibleViaState(0); })
      .then(function(v){ expect(v, 'click outside closes').to.equal(false); })
      .then(function(){ done() })
      .catch(done);
  });

  it('Single-open: opening button #1 hides button #0 popover', function(done){
    // Reload for clean state, open #0 by focus, then open #1.
    open_page_func({ url: application_host + 'calendar/teamview/', driver: driver })
      .then(function(){ return driver.sleep(150); })
      .then(function(){
        return driver.executeScript(function(){
          document.querySelectorAll('.team-view-user-details-summary-trigger')[0].focus();
        });
      })
      .then(function(){ return driver.wait(function(){ return isVisibleViaState(0); }, 1500); })
      .then(function(){ return describedBy(0); })
      .then(function(id0){ expect(id0.length).to.be.greaterThan(0); })
      .then(function(){
        return driver.executeScript(function(){
          document.querySelectorAll('.team-view-user-details-summary-trigger')[1].focus();
        });
      })
      .then(function(){ return driver.sleep(300); })
      .then(function(){ return isVisibleViaState(1); })
      .then(function(v1){ expect(v1, '#1 visible').to.equal(true); })
      .then(function(){ return isVisibleViaState(0); })
      .then(function(v0){ expect(v0, '#0 hidden after #1 opened').to.equal(false); })
      .then(function(){ return describedBy(0); })
      .then(function(id0After){ expect(id0After, '#0 aria-describedby removed').to.equal(''); })
      .then(visibleTeamViewPopoverCount)
      .then(function(n){ expect(n, 'exactly one popover visible').to.equal(1); })
      .then(function(){ done() })
      .catch(done);
  });

  it('Summary button click does not navigate to /users/edit/', function(done){
    // Reload, click the button, and confirm the URL stays on teamview.
    open_page_func({ url: application_host + 'calendar/teamview/', driver: driver })
      .then(function(){ return driver.sleep(150); })
      .then(function(){ return buttonAt(0); })
      .then(function(btn){
        return driver.executeScript('document.body.focus();')
          .then(function(){ return driver.sleep(100); })
          .then(function(){ return btn.click(); });
      })
      .then(function(){ return driver.sleep(300); })
      .then(function(){ return driver.getCurrentUrl(); })
      .then(function(url){
        expect(url, 'summary click must not navigate').to.match(/\/calendar\/teamview\/?(\?.*)?$/);
        expect(url).to.not.contain('/users/edit/');
      })
      .then(function(){ done() })
      .catch(done);
  });

  it('Admin link click navigates to /users/edit/:id/ without opening summary', function(done){
    // Reload Team View as admin, find the first employee edit link, confirm
    // the summary popover is closed, focus the link, press Enter, and verify
    // real navigation happened (not a popover open).
    open_page_func({ url: application_host + 'calendar/teamview/', driver: driver })
      .then(function(){ return driver.sleep(200); })
      .then(function(){
        return driver.executeScript(function(){
          var link = document.querySelector('.team-view-employee-link');
          if (!link) { return null; }
          // Ensure no popover is open.
          var btn = document.querySelector('.team-view-user-details-summary-trigger');
          var inst = btn && window.jQuery(btn).data('bs.popover');
          var tip = inst && inst.tip();
          return {
            href: link.getAttribute('href'),
            popoverClosed: !(tip && tip.is(':visible'))
          };
        });
      })
      .then(function(info){
        expect(info, 'expected an admin employee link').to.not.be.null;
        expect(info.href).to.match(/\/users\/edit\/\d+\//);
        expect(info.popoverClosed, 'popover should be closed before navigation').to.equal(true);
      })
      .then(function(){
        return driver.executeScript(function(){
          document.querySelector('.team-view-employee-link').focus();
        });
      })
      .then(function(){ return driver.sleep(100); })
      .then(function(){ return driver.switchTo().activeElement(); })
      .then(function(el){ return el.sendKeys(Key.ENTER); })
      .then(function(){ return driver.sleep(800); })
      .then(function(){ return driver.getCurrentUrl(); })
      .then(function(url){
        expect(url, 'should navigate to edit page').to.match(/\/users\/edit\/\d+\//);
        // Confirm the summary popover did NOT open during navigation.
        return driver.executeScript(function(){
          var btn = document.querySelector('.team-view-user-details-summary-trigger');
          // On the edit page there are no Team View triggers, so this is null.
          return btn === null;
        });
      })
      .then(function(noTrigger){
        // Being on the edit page proves navigation, not popover.
        expect(noTrigger, 'should be on edit page, not team view').to.equal(true);
      })
      // Return to Team View for any subsequent scenarios.
      .then(function(){
        return open_page_func({ url: application_host + 'calendar/teamview/', driver: driver });
      })
      .then(function(){ return driver.sleep(200); })
      .then(function(){ done(); })
      .catch(function(err){ done(err); });
  });

  it('Pending hover timer on one Team View button does not steal another\'s open popover', function(done){
    // Reload for clean state, then use real pointer move on button A to
    // schedule a 700ms hover show, then keyboard-focus button B before A opens.
    open_page_func({ url: application_host + 'calendar/teamview/', driver: driver })
      .then(function(){ return driver.sleep(200); })
      .then(function(){ return buttonAt(0); })
      .then(function(btnA){
        return driver.actions().move({origin: btnA}).perform();
      })
      // Wait briefly (less than the 700ms hover delay).
      .then(function(){ return driver.sleep(150); })
      // Verify A has a pending show timer but is not yet visible.
      .then(function(){
        return driver.executeScript(function(){
          var t = document.querySelectorAll('.team-view-user-details-summary-trigger')[0];
          var s = window.jQuery(t).data('userSummaryState');
          var inst = window.jQuery(t).data('bs.popover');
          var tip = inst && inst.tip();
          return { showTimerSet: !!(s && s.showTimer), visible: !!(tip && tip.is(':visible')) };
        });
      })
      .then(function(a){
        expect(a.showTimerSet, 'button A should have pending showTimer').to.equal(true);
        expect(a.visible, 'button A should not be visible yet').to.equal(false);
      })
      // Focus button B immediately (keyboard show is instant).
      .then(function(){
        return driver.executeScript(function(){
          document.querySelectorAll('.team-view-user-details-summary-trigger')[1].focus();
        });
      })
      .then(function(){ return driver.wait(function(){ return isVisibleViaState(1); }, 1500); })
      // Wait beyond the full hover delay so any stale timer on A would fire.
      .then(function(){ return driver.sleep(800); })
      .then(function(){ return isVisibleViaState(1); })
      .then(function(vB){ expect(vB, 'B should still be visible').to.equal(true); })
      .then(function(){ return isVisibleViaState(0); })
      .then(function(vA){ expect(vA, 'A should not have opened').to.equal(false); })
      .then(function(){
        return driver.executeScript(function(){
          var t = document.querySelectorAll('.team-view-user-details-summary-trigger')[0];
          var s = window.jQuery(t).data('userSummaryState');
          return s ? !!s.showTimer : 'no-state';
        });
      })
      .then(function(timerA){
        expect(timerA, 'A should have no pending showTimer').to.not.be.ok;
      })
      .then(function(){ return describedBy(1); })
      .then(function(idB){
        expect(idB.length, 'B should have aria-describedby').to.be.greaterThan(0);
      })
      .then(function(){ return describedBy(0); })
      .then(function(idA){
        expect(idA, 'A should not have aria-describedby').to.equal('');
      })
      .then(visibleTeamViewPopoverCount)
      .then(function(n){ expect(n, 'exactly one popover visible').to.equal(1); })
      .then(function(){ done(); })
      .catch(function(err){ done(err); });
  });

  it('Admin employee link keeps semantic contrast in dark theme', function(done){
    // Verify computed styles in dark theme, not just SCSS text.
    var originalTheme = null;
    open_page_func({ url: application_host + 'calendar/teamview/', driver: driver })
      .then(function(){ return driver.sleep(200); })
      // Remember the current theme so we can restore it even on failure.
      .then(function(){
        return driver.executeScript(function(){
          originalTheme = document.documentElement.getAttribute('data-theme') || 'light';
          return originalTheme;
        });
      })
      .then(function(theme){
        originalTheme = theme;
        // Enable dark theme the same way the app does.
        return driver.executeScript(function(){
          document.documentElement.setAttribute('data-theme', 'dark');
        });
      })
      .then(function(){ return driver.sleep(200); })
      .then(function(){
        return driver.executeScript(function(){
          var link = document.querySelector('.team-view-employee-link');
          var cell = document.querySelector('.left-column-cell');
          if (!link || !cell) { return {missing: true}; }
          var linkColor = getComputedStyle(link).color;
          var bgColor = getComputedStyle(cell).backgroundColor;
          // Resolve the semantic token value from the theme root.
          var tokenColor = getComputedStyle(document.documentElement)
            .getPropertyValue('--color-link').trim();
          return {
            linkColor: linkColor,
            bgColor: bgColor,
            tokenColor: tokenColor
          };
        });
      })
      .then(function(info){
        expect(info.missing, 'expected an admin link and a cell').to.not.be.true;
        // The computed link colour must resolve to the semantic token value.
        // getComputedStyle returns rgb(...), getPropertyValue returns the raw
        // token string (e.g. #8abcf5). Normalise both to 'r,g,b' for comparison.
        function normaliseColour(str) {
          var m = str.match(/rgba?\(([^)]+)\)/);
          if (m) { return m[1].split(',').map(function(v){return v.trim();}).slice(0,3).join(','); }
          // Hex form like #8abcf5
          var h = str.match(/^#([0-9a-f]{3,6})$/i);
          if (h) {
            var hex = h[1];
            if (hex.length === 3) { hex = hex.split('').map(function(c){return c+c;}).join(''); }
            var r = parseInt(hex.substr(0,2), 16);
            var g = parseInt(hex.substr(2,2), 16);
            var b = parseInt(hex.substr(4,2), 16);
            return [r,g,b].join(',');
          }
          return str.trim();
        }
        var linkNorm = normaliseColour(info.linkColor);
        var tokenNorm = normaliseColour(info.tokenColor);
        expect(linkNorm, 'link colour should use --color-link').to.equal(tokenNorm);
        function parseRgb(str) {
          var m = str.match(/rgba?\(([^)]+)\)/);
          if (!m) { return [0, 0, 0]; }
          return m[1].split(',').map(function(v) {
            return parseFloat(v.trim()) / 255;
          });
        }
        function lum(rgb) {
          return rgb.map(function(c) {
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
          }).reduce(function(acc, c, i) {
            return acc + c * [0.2126, 0.7152, 0.0722][i];
          }, 0);
        }
        function ratio(fg, bg) {
          var l1 = lum(parseRgb(fg));
          var l2 = lum(parseRgb(bg));
          var hi = Math.max(l1, l2);
          var lo = Math.min(l1, l2);
          return (hi + 0.05) / (lo + 0.05);
        }
        var r = ratio(info.linkColor, info.bgColor);
        expect(r, 'link contrast must be >= 4.5 in dark theme').to.be.at.least(4.5);
      })
      .then(function(){
        // Restore the original theme.
        return driver.executeScript(function(t){
          if (t === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
          } else {
            document.documentElement.removeAttribute('data-theme');
          }
        }, originalTheme);
      })
      .then(function(){ done(); })
      .catch(function(err){
        // Ensure theme restoration even on assertion failure.
        driver.executeScript(function(t){
          if (t === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
          } else {
            document.documentElement.removeAttribute('data-theme');
          }
        }, originalTheme || 'light').then(function(){ done(err); });
      });
  });

  after(function(done){
    driver.quit().then(function(){ done(); });
  });

});
