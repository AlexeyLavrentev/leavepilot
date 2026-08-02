'use strict';

var config           = require('../../lib/config'),
    application_host = config.get_application_host(),
    By               = require('selenium-webdriver').By,
    Key              = require('selenium-webdriver').Key,
    until            = require('selenium-webdriver').until,
    expect           = require('chai').expect,

    register_new_user_func = require('../../lib/register_new_user'),
    open_page_func         = require('../../lib/open_page');

describe('Team View horizontal table navigation', function(){

  this.timeout( config.get_execution_timeout() );

  var driver;

  it('Registers a new company (admin)', function(done){
    register_new_user_func({ application_host: application_host })
      .then(function(data){
        driver = data.driver;
        done();
      });
  });

  it('Opens Team View wide enough to require horizontal scroll (12 months)', function(done){
    // 12 months guarantees scrollWidth > clientWidth on the default 1024px window.
    open_page_func({
      url: application_host + 'calendar/teamview/?months=12',
      driver: driver,
    })
      .then(function(){ return driver.wait(until.elementLocated(By.css('.team-view-table-container')), 5000); })
      .then(function(){ return driver.sleep(400); })
      .then(function(){ done(); });
  });

  function firstShell() {
    return driver.executeScript(
      'return document.querySelector(".team-view-table-shell");'
    );
  }
  function firstContainer() {
    return driver.findElement(By.css('.team-view-table-container'));
  }
  function shellClasses() {
    return driver.executeScript(function(){
      var s = document.querySelector('.team-view-table-shell');
      return s ? s.className : '';
    });
  }
  function scrollLeftOf() {
    return driver.executeScript(function(){
      var c = document.querySelector('.team-view-table-container');
      return c ? c.scrollLeft : -1;
    });
  }
  function hasOverflow() {
    return driver.executeScript(function(){
      var c = document.querySelector('.team-view-table-container');
      return c ? (c.scrollWidth - c.clientWidth) > 2 : false;
    });
  }
  function cueVisible() {
    return driver.executeScript(function(){
      var s = document.querySelector('.team-view-table-shell');
      if (!s) { return false; }
      var cue = s.querySelector('.team-view-scroll-cue');
      if (!cue) { return false; }
      return getComputedStyle(cue).opacity !== '0';
    });
  }

  it('Confirms the table actually overflows horizontally', function(done){
    hasOverflow()
      .then(function(v){ expect(v, 'table should overflow at 12 months').to.equal(true); })
      .then(function(){ done(); });
  });

  it('Marks the shell as horizontally scrollable and can-scroll-right at start', function(done){
    shellClasses()
      .then(function(cls){
        expect(cls).to.contain('is-horizontally-scrollable');
        expect(cls).to.contain('can-scroll-right');
        expect(cls, 'no can-scroll-left at the left edge').to.not.contain('can-scroll-left');
      })
      .then(function(){ done(); });
  });

  it('Shows the scroll cue at the start', function(done){
    cueVisible()
      .then(function(v){ expect(v, 'cue should be visible when can-scroll-right').to.equal(true); })
      .then(function(){ done(); });
  });

  it('Focuses the scroll region', function(done){
    driver.executeScript('document.querySelector(".team-view-table-container").focus();')
      .then(function(){
        return driver.executeScript(function(){
          var c = document.querySelector('.team-view-table-container');
          return document.activeElement === c;
        });
      })
      .then(function(isFocused){ expect(isFocused).to.equal(true); })
      .then(function(){ done(); });
  });

  it('ArrowRight increases scrollLeft and keeps focus on the container', function(done){
    scrollLeftOf()
      .then(function(before){
        return driver.switchTo().activeElement()
          .then(function(el){ return el.sendKeys(Key.ARROW_RIGHT); })
          .then(function(){ return driver.sleep(150); })
          .then(function(){ return scrollLeftOf(); })
          .then(function(after){
            expect(after, 'ArrowRight should move scrollLeft forward').to.be.greaterThan(before);
          });
      })
      .then(function(){
        return driver.executeScript(function(){
          var c = document.querySelector('.team-view-table-container');
          return document.activeElement === c;
        });
      })
      .then(function(isFocused){ expect(isFocused, 'focus must stay on the container').to.equal(true); })
      .then(function(){ done(); });
  });

  it('After ArrowRight, can-scroll-left appears on the shell', function(done){
    shellClasses()
      .then(function(cls){ expect(cls).to.contain('can-scroll-left'); })
      .then(function(){ done(); });
  });

  it('End moves to the right edge and removes can-scroll-right', function(done){
    driver.switchTo().activeElement()
      .then(function(el){ return el.sendKeys(Key.END); })
      .then(function(){ return driver.sleep(150); })
      .then(function(){ return shellClasses(); })
      .then(function(cls){
        expect(cls, 'no can-scroll-right at the right edge').to.not.contain('can-scroll-right');
      })
      .then(function(){ return driver.sleep(100); })
      .then(function(){ return cueVisible(); })
      .then(function(v){ expect(v, 'cue should hide at the right edge').to.equal(false); })
      .then(function(){ done(); });
  });

  it('Home returns scrollLeft to zero and restores can-scroll-right', function(done){
    driver.switchTo().activeElement()
      .then(function(el){ return el.sendKeys(Key.HOME); })
      .then(function(){ return driver.sleep(150); })
      .then(function(){ return scrollLeftOf(); })
      .then(function(left){ expect(left).to.equal(0); })
      .then(function(){ return shellClasses(); })
      .then(function(cls){ expect(cls).to.contain('can-scroll-right'); })
      .then(function(){ done(); });
  });

  it('Keyboard on a nested admin link is not handled by the table controller', function(done){
    // The admin company has at least one employee row with a real edit link.
    driver.findElements(By.css('.teamview-user-list-row .cross-link a'))
      .then(function(els){
        expect(els.length, 'expected an admin employee link').to.be.greaterThan(0);
        var link = els[0];

        // Capture whether the document-level keydown (which fires AFTER the
        // container's delegated handler) sees the event as defaultPrevented.
        return driver.executeScript(function(){
          window.__teamViewNestedKeyDefaultPrevented = null;
          window.jQuery(document).one('keydown.teamViewNavigationTest', function(e){
            window.__teamViewNestedKeyDefaultPrevented = e.isDefaultPrevented();
          });
        })
          .then(function(){
            return driver.executeScript(function(el){ el.focus(); }, link);
          })
          .then(function(){ return driver.sleep(100); })
          .then(function(){
            // Confirm the link kept its real edit href.
            return driver.executeScript(function(el){
              return {
                href: el.getAttribute('href'),
                isFocused: document.activeElement === el
              };
            }, link);
          })
          .then(function(info){
            expect(info.href, 'admin link should keep its edit href').to.match(/\/users\/edit\/\d+\//);
            expect(info.isFocused, 'link should be focused before the keypress').to.equal(true);
          })
          .then(function(){ return link.sendKeys(Key.ARROW_RIGHT); })
          .then(function(){ return driver.sleep(200); })
          .then(function(){
            return driver.executeScript(function(){
              return {
                defaultPrevented: window.__teamViewNestedKeyDefaultPrevented,
                activeIsLink: document.activeElement && document.activeElement.tagName === 'A'
              };
            });
          })
          .then(function(info){
            // The container controller must NOT have called preventDefault for
            // a key originating on a nested element.
            expect(info.defaultPrevented, 'container must not preventDefault on a nested element keypress').to.equal(false);
            expect(info.activeIsLink, 'focus should remain on the link after ArrowRight').to.equal(true);
          })
          // Cleanup the test-only handler and temp field.
          .then(function(){
            return driver.executeScript(function(){
              window.jQuery(document).off('keydown.teamViewNavigationTest');
              delete window.__teamViewNestedKeyDefaultPrevented;
            });
          });
      })
      .then(function(){ done(); })
      .catch(function(err){ done(err); });
  });

  it('Scroll cue remains visible near the top of a tall department table', function(done){
    // Reload to a clean state, then inflate ONE department table with many
    // cloned rows purely in the test DOM (no production data change) so the
    // shell becomes much taller than the viewport.
    open_page_func({ url: application_host + 'calendar/teamview/?months=6', driver: driver })
      .then(function(){ return driver.wait(until.elementLocated(By.css('.team-view-table-container')), 5000); })
      .then(function(){ return driver.sleep(300); })
      .then(function(){
        return driver.executeScript(function(){
          var tbody = document.querySelector('.team-view-table tbody');
          if (!tbody) { return {cloned: 0}; }
          var rows = tbody.querySelectorAll('tr.teamview-user-list-row');
          if (!rows.length) { return {cloned: 0}; }
          var template = rows[0];
          // Clone ~30 times so the shell is well beyond the viewport height.
          for (var i = 0; i < 30; i++) {
            tbody.appendChild(template.cloneNode(true));
          }
          var shell = document.querySelector('.team-view-table-shell');
          return {cloned: 30, shellHeight: shell ? shell.offsetHeight : 0};
        });
      })
      .then(function(info){
        expect(info.cloned, 'should have cloned rows').to.equal(30);
        expect(info.shellHeight, 'shell should be tall').to.be.greaterThan(900);
      })
      .then(function(){
        // Make sure the table overflows horizontally (6 months at this width).
        return driver.executeScript(function(){
          var c = document.querySelector('.team-view-table-container');
          // Force horizontal overflow for the test if it is not present yet,
          // by temporarily narrowing the container so the cue has a reason to
          // show. We do NOT touch production styles — only the in-test DOM.
          if ((c.scrollWidth - c.clientWidth) <= 2) {
            c.style.maxWidth = '420px';
          }
          return (c.scrollWidth - c.clientWidth) > 2;
        });
      })
      .then(function(overflows){
        expect(overflows, 'table should overflow horizontally for the cue test').to.equal(true);
      })
      .then(function(){
        // Scroll the page so the START of the tall shell is at the top of the
        // viewport (how a user first reaches the table).
        return driver.executeScript(function(){
          var shell = document.querySelector('.team-view-table-shell');
          shell.scrollIntoView({block: 'start'});
        });
      })
      .then(function(){ return driver.sleep(200); })
      .then(function(){
        return driver.executeScript(function(){
          var shell = document.querySelector('.team-view-table-shell');
          var cue = document.querySelector('.team-view-scroll-cue');
          var sRect = shell.getBoundingClientRect();
          var cRect = cue.getBoundingClientRect();
          var vw = window.innerWidth;
          var vh = window.innerHeight;
          return {
            cueW: Math.round(cRect.width),
            cueH: Math.round(cRect.height),
            cueTop: Math.round(cRect.top),
            cueBottom: Math.round(cRect.bottom),
            cueIntersectsViewport: cRect.bottom > 0 && cRect.top < vh && cRect.right > 0 && cRect.left < vw,
            shellTop: Math.round(sRect.top),
            shellBottom: Math.round(sRect.bottom),
            // Distance from the top of the shell to the vertical center of the cue.
            cueOffsetFromShellTop: Math.round((cRect.top + cRect.height / 2) - sRect.top)
          };
        });
      })
      .then(function(g){
        expect(g.cueW, 'cue should have non-zero width').to.be.greaterThan(0);
        expect(g.cueH, 'cue should have non-zero height').to.be.greaterThan(0);
        expect(g.cueIntersectsViewport, 'cue should intersect the viewport').to.equal(true);
        // Cue must sit near the top of the shell, not around the vertical center
        // (which on a tall table would be below the fold).
        expect(g.cueOffsetFromShellTop, 'cue should be near the top of the shell')
          .to.be.lessThan(160);
        // Cue must remain within the shell's vertical bounds.
        expect(g.cueBottom, 'cue should not extend below the shell').to.be.at.most(g.shellBottom + 1);
      })
      // Reload to drop the cloned rows before the next scenario.
      .then(function(){
        return open_page_func({ url: application_host + 'calendar/teamview/?months=12', driver: driver });
      })
      .then(function(){ return driver.sleep(200); })
      .then(function(){ done(); })
      .catch(function(err){ done(err); });
  });

  it('Mobile (390px) period navigation lays out without page overflow', function(done){
    // Switch to a mobile viewport and verify computed geometry.
    driver.manage().window().setRect({width: 390, height: 844})
      .then(function(){ return open_page_func({ url: application_host + 'calendar/teamview/?months=1', driver: driver }); })
      .then(function(){ return driver.wait(until.elementLocated(By.css('.team-view-table')), 5000); })
      .then(function(){ return driver.sleep(400); })
      .then(function(){
        return driver.executeScript(function(){
          var prev = document.querySelector('.period-navigation-side:first-child .team-view-period-link');
          var next = document.querySelector('.period-navigation-side:last-child .team-view-period-link');
          var caption = document.querySelector('.calendar-section-caption');
          var btn = document.getElementById('team_view_month_select_btn');
          var label = document.querySelector('.team-view-period-link-label');
          var prevRect = prev ? prev.getBoundingClientRect() : null;
          var nextRect = next ? next.getBoundingClientRect() : null;
          var captionRect = caption ? caption.getBoundingClientRect() : null;
          var btnRect = btn ? btn.getBoundingClientRect() : null;
          var labelStyle = label ? getComputedStyle(label) : null;
          return {
            bodyScrollWidth: document.documentElement.scrollWidth,
            viewportWidth: document.documentElement.clientWidth,
            prevW: prevRect ? Math.round(prevRect.width) : 0,
            prevH: prevRect ? Math.round(prevRect.height) : 0,
            nextW: nextRect ? Math.round(nextRect.width) : 0,
            nextH: nextRect ? Math.round(nextRect.height) : 0,
            captionW: captionRect ? Math.round(captionRect.width) : 0,
            btnW: btnRect ? Math.round(btnRect.width) : 0,
            btnWithinCaption: btnRect && captionRect ? (btnRect.width <= captionRect.width + 1) : false,
            labelDisplay: labelStyle ? labelStyle.display : null,
            chevronVisible: !!document.querySelector('.team-view-period-link .fa')
          };
        });
      })
      .then(function(g){
        // No horizontal page overflow beyond the 390px viewport (+ small tolerance).
        expect(g.bodyScrollWidth, 'page must not overflow horizontally').to.be.at.most(g.viewportWidth + 2);
        // Side areas roughly the 48px grid track (small padding tolerance).
        expect(g.prevW, 'prev side ~48px').to.be.within(44, 60);
        expect(g.nextW, 'next side ~48px').to.be.within(44, 60);
        // Touch targets at least 44x44.
        expect(g.prevH, 'prev target height >=44').to.be.at.least(44);
        expect(g.nextH, 'next target height >=44').to.be.at.least(44);
        // Central caption is the widest of the three areas (gets the 1fr track).
        expect(g.captionW, 'central caption should be the widest area')
          .to.be.greaterThan(Math.max(g.prevW, g.nextW));
        expect(g.btnWithinCaption, 'month picker must not exceed its area').to.equal(true);
        // Month abbreviation label hidden, chevron still visible.
        expect(g.labelDisplay, 'abbreviated month label should be hidden').to.equal('none');
        expect(g.chevronVisible, 'chevron should remain visible').to.equal(true);
      })
      // Restore the default window size for any following scenarios.
      .then(function(){ return driver.manage().window().setRect({width: 1024, height: 768}); })
      .then(function(){ done(); })
      .catch(function(err){ done(err); });
  });

  after(function(done){
    driver.quit().then(function(){ done(); });
  });

});
