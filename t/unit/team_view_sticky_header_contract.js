'use strict';

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

describe('Team View sticky header contracts', function() {
  const template = read(path.join('views', 'partials', 'team_view_table.hbs'));
  const javascript = read(path.join('public', 'js', 'global.js'));
  const scss = read(path.join('scss', 'main.scss'));
  const css = read(path.join('public', 'css', 'style.css'));

  function controllerSource() {
    const start = javascript.indexOf('(function initTeamViewStickyHeaders(){');
    const end = javascript.indexOf('\n\n$(document).ready(function(){', start);
    expect(start, 'sticky controller should exist').to.be.greaterThan(-1);
    expect(end, 'sticky controller should be isolated').to.be.greaterThan(start);
    return javascript.slice(start, end);
  }

  describe('server markup and semantics', function() {
    it('places one hidden aria-hidden overlay after the source container and before the cue', function() {
      const containerIndex = template.indexOf('team-view-table-container');
      const overlayIndex = template.indexOf('class="team-view-sticky-header"');
      const cueIndex = template.indexOf('team-view-scroll-cue');
      expect(containerIndex).to.be.lessThan(overlayIndex);
      expect(overlayIndex).to.be.lessThan(cueIndex);
      expect(template).to.match(/<div class="team-view-sticky-header" aria-hidden="true" hidden>/);
    });

    it('server-renders only an empty presentation table header in the overlay', function() {
      const overlay = template.slice(template.indexOf('class="team-view-sticky-header"'), template.indexOf('team-view-scroll-cue'));
      expect(overlay).to.contain('team-view-sticky-header-viewport');
      expect(overlay).to.match(/class="team-view-table team-view-sticky-header-table" role="presentation"/);
      expect(overlay).to.match(/<thead><\/thead>/);
      expect(overlay).not.to.contain('<tbody');
      expect(overlay).not.to.match(/tabindex|role="region"|<caption/);
    });

    it('preserves the original semantic table and scroll-region contracts', function() {
      expect(template).to.match(/team-view-table-container" role="region" aria-label="\{\{department\.departmentName\}\}" tabindex="0"/);
      expect(template).to.match(/<table class="team-view-table table-hover">[\s\S]*<caption class="sr-only">/);
      expect(template).to.match(/<thead>[\s\S]*scope="colgroup"[\s\S]*scope="col"/);
      expect(template.indexOf('team-view-table table-hover')).to.be.lessThan(template.indexOf('team-view-sticky-header-table'));
    });
  });

  describe('manual fallback controller', function() {
    it('uses marker-scoped source selectors, state, and event namespace', function() {
      const source = controllerSource();
      expect(source).to.contain("var STATE_KEY = 'teamViewStickyHeaderState'");
      expect(source).to.contain("var EVENT_NAMESPACE = '.teamViewStickyHeader'");
      expect(source).to.contain("$('.team-view-table-shell')");
      expect(source).to.contain(".children('.team-view-table:not(.team-view-sticky-header-table)')");
      expect(source).to.contain('$shell.data(STATE_KEY, state)');
      ['shell', 'container', 'sourceTable', 'sourceThead', 'overlay', 'overlayViewport', 'overlayTable', 'active', 'measured'].forEach(function(field){
        expect(source).to.match(new RegExp(field + ':'));
      });
    });

    it('clones only thead without events/data and sanitises clone state', function() {
      const source = controllerSource();
      expect(source).to.contain('$sourceThead.clone(false, false)');
      expect(source).to.contain(".removeAttr('id tabindex aria-describedby data-toggle data-trigger')");
      expect(source).to.contain('.removeData()');
      expect(source).to.contain('.off()');
      expect(source).to.contain("attributeName.indexOf('data-')");
      expect(source).to.contain("attributeName.indexOf('aria-')");
      expect(source).to.contain("$clone.find('a, button, input, select, textarea, [contenteditable]')");
      expect(source).not.to.match(/clone\([^)]*\)[\s\S]{0,100}tbody/);
    });

    it('derives widths and fixed geometry from live source measurements', function() {
      const source = controllerSource();
      expect(source).to.contain("state.sourceThead.querySelectorAll('th')");
      expect(source).to.contain("state.cloneThead.querySelectorAll('th')");
      expect(source).to.contain('getBoundingClientRect().width');
      expect(source).to.contain('state.sourceTable.scrollWidth');
      expect(source).to.contain("geometry.containerRect.left + 'px'");
      expect(source).to.contain("geometry.containerRect.width + 'px'");
      expect(source).to.contain("state.headerHeight + 'px'");
      expect(source).to.contain("state.container.clientWidth + 'px'");
      expect(source).to.contain("state.container.clientLeft + 'px'");
      expect(source).to.contain('state.overlayViewport.scrollLeft = state.container.scrollLeft');
      expect(source).not.to.match(/DATE_WIDTH|DAY_WIDTH|\b(?:28|30|31|32|40|42|44|48|56)\s*\*\s*(?:months|days)/);
    });

    it('uses one rAF scheduler with measured native and shell boundaries', function() {
      const source = controllerSource();
      expect(source).to.contain('var frameScheduled = false');
      expect(source).to.contain('window.requestAnimationFrame(refresh)');
      expect(source.match(/requestAnimationFrame/g)).to.have.length(2);
      expect(source).to.contain('sourceTheadRect.top < 0');
      expect(source).to.contain('nativeStickyActive');
      expect(source).to.contain('shellRect.bottom > state.headerHeight');
      expect(source).to.contain('activeState = states[index]');
      expect(source).to.contain('state.overlay.hidden = true');
      expect(source).to.contain('state.overlay.hidden = false');
    });

    it('binds only namespaced scroll/resize observation without polling or network work', function() {
      const source = controllerSource();
      expect(source).to.contain(".on('scroll' + EVENT_NAMESPACE");
      expect(source).to.contain(".on('resize' + EVENT_NAMESPACE");
      expect(source).to.contain('new window.ResizeObserver');
      expect(source).not.to.match(/setInterval|setTimeout|MutationObserver|ajax|XMLHttpRequest|fetch\s*\(/i);
      expect(source).not.to.contain('.teamViewNavigation');
      expect(source).not.to.match(/interactive-(?:teamview-deducted-days|leave-details|user-details)/);
    });
  });

  describe('scoped visual layer', function() {
    it('defines a fixed, hidden, clipped, non-click-through overlay below popovers', function() {
      expect(scss).to.match(/\.team-view-sticky-header\s*\{[\s\S]*position:\s*fixed;[\s\S]*top:\s*0;[\s\S]*z-index:\s*20;[\s\S]*overflow:\s*hidden;[\s\S]*background:\s*\$surface-muted;[\s\S]*box-shadow:\s*\$shadow-sm;[\s\S]*pointer-events:\s*auto;/);
      expect(scss).to.match(/\.team-view-sticky-header\[hidden\]\s*\{[^}]*display:\s*none;/s);
      expect(scss).not.to.match(/\.team-view-sticky-header[^{]*\{[^}]*pointer-events:\s*none/s);
      expect(scss).not.to.match(/\.team-view-sticky-header[^{]*\{[^}]*(?:transition|animation):/s);
    });

    it('keeps the overlay viewport clipped and the name group horizontally sticky', function() {
      expect(scss).to.match(/\.team-view-sticky-header-viewport\s*\{[^}]*overflow:\s*hidden;/s);
      expect(scss).to.match(/\.team-view-sticky-header-table\s*\{[^}]*table-layout:\s*fixed;/s);
      expect(scss).to.match(/\.team-view-sticky-header-table \.team-view-name-header\s*\{[^}]*position:\s*sticky;[^}]*left:\s*0;/s);
      expect(scss).to.match(/\.team-view-table thead th\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s);
    });

    it('keeps generated CSS synchronized with semantic light and dark surfaces', function() {
      expect(css).to.contain('.team-view-sticky-header');
      expect(css).to.match(/\.team-view-sticky-header\s*\{[^}]*position:\s*fixed;/s);
      expect(css).to.match(/\[data-theme=dark\][^{]*\.team-view-sticky-header[^{]*\{[^}]*background:\s*#20252a/s);
      expect(css).not.to.match(/\.team-view-sticky-header[^{]*\{[^}]*(?:transition|animation):/s);
    });
  });
});
