
$(function () {
  var csrfToken = window.timeoff && window.timeoff.csrfToken;

  if (!csrfToken) {
    return;
  }

  $('form').each(function () {
    var method = String($(this).attr('method') || 'GET').toUpperCase();
    if (method !== 'GET' && !$(this).find('input[name="_csrf"]').length) {
      $('<input>', {type: 'hidden', name: '_csrf', value: csrfToken}).appendTo(this);
    }
  });

  $(document).ajaxSend(function (_event, xhr, settings) {
    var method = String(settings.type || settings.method || 'GET').toUpperCase();
    var url = document.createElement('a');
    url.href = settings.url || '';
    var sameOrigin = !url.host || url.host === window.location.host;
    if (sameOrigin && !/^(GET|HEAD|OPTIONS)$/.test(method)) {
      xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    }
  });
});

/*
 * Book Leave request pop-up window.
 *
 * */
$(document).ready(function(){
  /*
   *  When FROM field in New absense form chnages: update TO one if necessary
   */
  $('input.book-leave-from-input').on('change', function(e){
    e.stopPropagation();

    var from_date = $('input.book-leave-from-input').datepicker('getDate');

    if ( ! from_date ) {
      // no new value for FROM part, do nothing
      console.log('No from date');
      return;
    }

    var to_date = $('input.book-leave-to-input').datepicker('getDate');

    if ( ! to_date || ( to_date && to_date.getTime() < from_date.getTime() )) {
      $('input.book-leave-to-input').datepicker('setDate', $('input.book-leave-from-input').datepicker('getFormattedDate'));
    }
  });
});

$(document).ready(function(){
  var translations = (window.timeoff && window.timeoff.translations) || {};

  $(document).on('click', '.vacation-plan-conflict-toggle', function(){
    var $button = $(this);
    var $placeholder = $button.next('.vacation-plan-conflict-details-placeholder');

    if (!$placeholder.length) {
      return;
    }

    if (!$placeholder.hasClass('hidden')) {
      $placeholder.addClass('hidden');
      $button.attr('aria-expanded', 'false');
      return;
    }

    $button.attr('aria-expanded', 'true');
    $placeholder.removeClass('hidden');

    if ($placeholder.data('loaded')) {
      return;
    }

    $placeholder
      .html('<span class="text-muted">' + translations.loading + '</span>')
      .load($button.data('conflict-url'), function(response, status){
        if (status === 'error') {
          $placeholder.text(translations.requestFailed);
          return;
        }

        $placeholder.data('loaded', true);
      });
  });
});


/*
 * Bootstrap-datepicker
 *
 * */
$(function () {
  var locale = (window.timeoff && window.timeoff.locale) || 'en';
  var datepickerLocale = locale === 'en' ? 'en-GB' : locale;
  var translations = (window.timeoff && window.timeoff.translations) || {};
  var datepickerTranslations = translations.datepicker;

  /*
    The date picker is only linked on pages that have a date field, so this
    script has to work without it. It used to assume otherwise: the translation
    block below is present in every response, so on a page without the plugin
    this threw a TypeError and took the rest of this ready handler with it -
    including the tooltip setup.
  */
  if (datepickerTranslations && $.fn.datepicker) {
    $.fn.datepicker.dates[datepickerLocale] = datepickerTranslations;
    $.fn.datepicker.defaults.language = datepickerLocale;
  }

  $('[data-toggle="tooltip"]').tooltip({
    container: 'body',
    viewport: {
      selector: 'body',
      padding: 8,
    },
  })
})

$(function () {
  $('[data-toggle="popover"]').popover({
    container: 'body',
    viewport: {
      selector: 'body',
      padding: 8,
    },
  })
})

/*
 * This is handler for invocation of "add secondary supervisors" modal
 *
 * */

$('#add_secondary_supervisers_modal').on('show.bs.modal', function (event) {
  var button = $(event.relatedTarget),
      department_name = button.data('department_name'),
      department_id = button.data('department_id');
  var translations = (window.timeoff && window.timeoff.translations) || {};

  var modal = $(this);

  modal.find('.modal-title strong').text(department_name);

  // Make modal window to be no hiegher then window and its content
  // scrollable
  $('.modal .modal-body').css('overflow-y', 'auto');
  $('.modal .modal-body').css('max-height', $(window).height() * 0.7);

  $(this).find(".modal-body")
    // Show "loading" icon while content of modal is loaded
    .html('<p class="text-center"><i class="fa fa-refresh fa-spin fa-3x fa-fw"></i><span class="sr-only">' + translations.loading + '</span></p>')
    .load('/settings/departments/available-supervisors/'+department_id+'/', function(response, status){
      if (status === 'error') {
        $(this).text(translations.requestFailed);
      }
    });
});

/*
 *  Given URL string return its query paramters as object.
 *
 *  If URL is not provided location of current page is used.
 * */

function getUrlVars(url){
  if ( ! url ) {
    url = window.location.href;
  }
  var vars = {}, hash;
  var hashes = url.slice( url.indexOf('?') + 1).split('&');
  for (var i = 0; i < hashes.length; i++) {
    hash = hashes[i].split('=');
    vars[hash[0]] = hash[1];
  }
  return vars;
}

/*
 * Evend that is fired when user change base date (current month) on Team View page.
 *
 * */

$(document).ready(function(){

  /*
    Same reason as above: without the plugin .datepicker is not a function, and
    the throw would take every binding after it in this handler with it. Scoped
    to this one chain rather than returning early, so the rest of the handler
    keeps running on a page that has no date field.
  */
  ($.fn.datepicker ? $('#team_view_month_select_btn').datepicker() : $())
    .on('changeDate', function(e) {
      $('#team-view-loading').removeClass('hidden');

      var url = $(e.currentTarget).data('tom');

      var form = document.createElement("form");
      form.method = 'GET';
      form.action = url;

      var url_params = getUrlVars( url );
      url_params['date'] = e.format('yyyy-mm');

      // Move query parameters into the form
      $.each( url_params, function(key, val){
        var inp = document.createElement("input");
        inp.name = key;
        inp.value = val;
        inp.type = 'hidden';
        form.appendChild(inp);
      });

      document.body.appendChild(form);

      return form.submit();
    });

  if ($('#team_view_month_select_btn').length) {
    $(document).on('click', '.team-view-filters a, nav a, .team-view-months-buttons a', function() {
      var $link = $(this);
      var href = $link.attr('href');

      // Ignore controls that only toggle UI state (dropdowns/modals), they do not navigate.
      if (!href || href === '#' || href.indexOf('javascript:') === 0 || $link.is('[data-toggle="dropdown"], [data-toggle="modal"]')) {
        return;
      }

      $('#team-view-loading').removeClass('hidden');
    });
  }
});


/*
 * Team View: horizontal scroll affordance + keyboard navigation.
 *
 * Each `.team-view-table-container` is a focusable scroll region (tabindex=0,
 * role=region). This controller:
 *   - tracks whether the table overflows horizontally and which ends are
 *     reachable, reflecting that on the surrounding `.team-view-table-shell`
 *     via the classes is-horizontally-scrollable / can-scroll-left /
 *     can-scroll-right (the CSS shows/hides the scroll cue accordingly);
 *   - lets a keyboard user move the scroll position with ArrowLeft/ArrowRight
 *     and jump to either end with Home/End, but ONLY when focus is directly
 *     on the scroll container — never when it is on a link, dropdown,
 *     popover trigger or any other nested interactive element.
 *
 * The implementation is intentionally framework-free: a single rAF-batched
 * refresh on load/scroll/resize plus a namespaced keydown handler.
 */
$(document).ready(function(){
  var SCROLL_TOLERANCE_PX = 2;
  var $containers = $('.team-view-table-container');
  if (!$containers.length) { return; }

  function shellOf(container) {
    // The shell is the positioned ancestor that hosts the cue and state
    // classes. It wraps the scroll container in the markup.
    return container.parentNode && container.parentNode.classList &&
      container.parentNode.classList.contains('team-view-table-shell')
      ? container.parentNode : null;
  }

  /*
    scrollWidth and clientWidth are integers, and on some platforms they
    disagree with the range the browser will actually scroll: the derived
    maximum sat a scrollbar's width past the real end, so scrolling all the way
    right still reported 15px left to go and the right-hand cue never cleared.
    Measuring how much content is still hidden past each edge answers the same
    question from the geometry the user can see, in fractional pixels.
  */
  function hiddenExtents(container) {
    var content = container.firstElementChild;

    if (!content) {
      var derived = container.scrollWidth - container.clientWidth;
      return {left: container.scrollLeft, right: derived - container.scrollLeft};
    }

    var containerRect = container.getBoundingClientRect();
    var contentRect = content.getBoundingClientRect();

    return {
      left: containerRect.left - contentRect.left,
      right: contentRect.right - containerRect.right,
    };
  }

  function maxScrollLeft(container) {
    return container.scrollLeft + hiddenExtents(container).right;
  }

  function refreshContainer(container) {
    var shell = shellOf(container);
    if (!shell) { return; }
    var hidden = hiddenExtents(container);
    var horizontallyScrollable = (hidden.left + hidden.right) > SCROLL_TOLERANCE_PX;
    var canLeft = horizontallyScrollable && hidden.left > SCROLL_TOLERANCE_PX;
    var canRight = horizontallyScrollable && hidden.right > SCROLL_TOLERANCE_PX;

    shell.classList.toggle('is-horizontally-scrollable', horizontallyScrollable);
    shell.classList.toggle('can-scroll-left', canLeft);
    shell.classList.toggle('can-scroll-right', canRight);
  }

  var refreshScheduled = false;
  function scheduleRefreshAll() {
    if (refreshScheduled) { return; }
    refreshScheduled = true;
    // rAF batches multiple events (scroll + resize) into one paint-friendly pass.
    (window.requestAnimationFrame || function(cb){ window.setTimeout(cb, 16); })(function(){
      refreshScheduled = false;
      $containers.each(function(){ refreshContainer(this); });
    });
  }

  // Initial state, after layout settles.
  scheduleRefreshAll();

  // Per-container scroll updates its own shell classes.
  $containers.on('scroll.teamViewNavigation', function(){
    refreshContainer(this);
  });

  // One shared resize handler refreshes every container.
  $(window).on('resize.teamViewNavigation', scheduleRefreshAll);

  // Keyboard horizontal scrolling, only when focus is directly on the region.
  $containers.on('keydown.teamViewNavigation', function(event){
    var container = this;
    var key = event.key;
    var supported = (key === 'ArrowLeft' || key === 'ArrowRight' ||
                     key === 'Home' || key === 'End');
    if (!supported) { return; }

    // When focus is on a nested interactive element (admin employee link,
    // dropdown, popover trigger, ...), do not drive the scroll ourselves.
    // This controller only owns keyboard scrolling when the scroll region
    // itself is focused. Whatever the browser does by default for a nested
    // element (including native scrolling of an ancestor) is outside the
    // responsibility of this controller.
    if (event.target !== container) {
      return;
    }

    var max = maxScrollLeft(container);
    // Only consume the key when there is actual horizontal overflow to move.
    if (max <= SCROLL_TOLERANCE_PX) { return; }

    var before = container.scrollLeft;
    var step = Math.max(80, Math.round(container.clientWidth * 0.25));

    if (key === 'ArrowRight') {
      container.scrollLeft = before + step;
    } else if (key === 'ArrowLeft') {
      container.scrollLeft = before - step;
    } else if (key === 'Home') {
      container.scrollLeft = 0;
    } else if (key === 'End') {
      container.scrollLeft = max;
    }
    // Instant scroll (no smooth behaviour) for predictability and for
    // compatibility with prefers-reduced-motion.
    event.preventDefault();
    // Focus stays on the container; refreshContainer runs on the scroll event.
  });
});


/*
 * Team View: page-level sticky header fallback.
 *
 * The source table remains the only semantic table. When an overflow-x
 * ancestor prevents its native sticky cells from following document scroll,
 * this controller displays one aria-hidden clone of the source <thead>.
 * Geometry is measured from the live source and every update is rAF-batched.
 */
(function initTeamViewStickyHeaders(){
  $(document).ready(function(){
    var STATE_KEY = 'teamViewStickyHeaderState';
    var EVENT_NAMESPACE = '.teamViewStickyHeader';
    var NATIVE_STICKY_TOLERANCE_PX = 1.5;
    var $shells = $('.team-view-table-shell');
    var states = [];
    var frameScheduled = false;
    var measureRequested = true;

    if (!$shells.length || !window.requestAnimationFrame) { return; }

    function sanitiseClone($clone) {
      var $cloneTree = $clone.add($clone.find('*'));

      $cloneTree
        .off()
        .removeData()
        .removeAttr('id tabindex aria-describedby data-toggle data-trigger');

      $cloneTree.each(function(){
        var attributes = this.attributes;
        for (var index = attributes.length - 1; index >= 0; index -= 1) {
          var attributeName = attributes[index].name;
          if (attributeName.indexOf('data-') === 0 ||
              attributeName.indexOf('aria-') === 0) {
            this.removeAttribute(attributeName);
          }
        }
      });

      $clone.find('a, button, input, select, textarea, [contenteditable]').each(function(){
        var $element = $(this);
        $element.removeAttr('href tabindex contenteditable name form aria-label aria-labelledby');
        if ($element.is('button, input, select, textarea')) {
          $element.prop('disabled', true);
        }
      });

      return $clone;
    }

    function buildState(shell) {
      var $shell = $(shell);
      var $container = $shell.children('.team-view-table-container').first();
      var $sourceTable = $container
        .children('.team-view-table:not(.team-view-sticky-header-table)')
        .first();
      var $sourceThead = $sourceTable.children('thead').first();
      var $overlay = $shell.children('.team-view-sticky-header').first();
      var $overlayViewport = $overlay.children('.team-view-sticky-header-viewport').first();
      var $overlayTable = $overlayViewport.children('.team-view-sticky-header-table').first();

      if (!$container.length || !$sourceTable.length || !$sourceThead.length ||
          !$overlay.length || !$overlayViewport.length || !$overlayTable.length) {
        return null;
      }

      var $cloneThead = sanitiseClone($sourceThead.clone(false, false));
      $overlayTable.children('thead').replaceWith($cloneThead);
      $overlay.prop('hidden', true);

      var state = {
        shell: shell,
        container: $container[0],
        sourceTable: $sourceTable[0],
        sourceThead: $sourceThead[0],
        overlay: $overlay[0],
        overlayViewport: $overlayViewport[0],
        overlayTable: $overlayTable[0],
        cloneThead: $cloneThead[0],
        active: false,
        measured: false,
        headerHeight: 0,
        tableWidth: 0
      };

      $shell.data(STATE_KEY, state);
      return state;
    }

    function measureState(state) {
      var sourceHeaders = state.sourceThead.querySelectorAll('th');
      var cloneHeaders = state.cloneThead.querySelectorAll('th');
      var sourceTheadRect = state.sourceThead.getBoundingClientRect();
      var tableWidth = state.sourceTable.scrollWidth;

      if (!sourceHeaders.length || sourceHeaders.length !== cloneHeaders.length ||
          !sourceTheadRect.height || !tableWidth) {
        state.measured = false;
        return;
      }

      for (var index = 0; index < sourceHeaders.length; index += 1) {
        var width = sourceHeaders[index].getBoundingClientRect().width;
        cloneHeaders[index].style.width = width + 'px';
        cloneHeaders[index].style.minWidth = width + 'px';
        cloneHeaders[index].style.maxWidth = width + 'px';
      }

      state.headerHeight = sourceTheadRect.height;
      state.tableWidth = tableWidth;
      state.overlayTable.style.width = tableWidth + 'px';
      state.overlayTable.style.minWidth = tableWidth + 'px';
      state.overlayTable.style.maxWidth = tableWidth + 'px';
      state.measured = true;
    }

    function candidateGeometry(state) {
      var shellRect = state.shell.getBoundingClientRect();
      var containerRect = state.container.getBoundingClientRect();
      var sourceTheadRect = state.sourceThead.getBoundingClientRect();
      var firstHeader = state.sourceThead.querySelector('th');
      var firstHeaderRect = firstHeader && firstHeader.getBoundingClientRect();
      var nativeStickyActive = firstHeaderRect &&
        sourceTheadRect.top < 0 &&
        firstHeaderRect.top >= -NATIVE_STICKY_TOLERANCE_PX &&
        firstHeaderRect.top <= NATIVE_STICKY_TOLERANCE_PX;
      var ownsViewportTop = sourceTheadRect.top < 0 &&
        shellRect.bottom > state.headerHeight &&
        containerRect.right > 0 &&
        containerRect.left < window.innerWidth;

      return {
        eligible: state.measured && ownsViewportTop && !nativeStickyActive,
        containerRect: containerRect
      };
    }

    function hideState(state) {
      if (!state.active && state.overlay.hidden) { return; }
      state.active = false;
      state.overlay.hidden = true;
    }

    function showState(state, geometry) {
      var overlayStyle = state.overlay.style;
      overlayStyle.left = geometry.containerRect.left + 'px';
      overlayStyle.width = geometry.containerRect.width + 'px';
      overlayStyle.height = state.headerHeight + 'px';
      state.overlayViewport.style.width = state.container.clientWidth + 'px';
      state.overlayViewport.style.marginLeft = state.container.clientLeft + 'px';
      state.overlayViewport.scrollLeft = state.container.scrollLeft;
      state.overlay.hidden = false;
      state.active = true;
    }

    function refresh() {
      frameScheduled = false;

      if (measureRequested) {
        for (var measureIndex = 0; measureIndex < states.length; measureIndex += 1) {
          measureState(states[measureIndex]);
        }
        measureRequested = false;
      }

      var activeState = null;
      var activeGeometry = null;

      for (var index = 0; index < states.length; index += 1) {
        var geometry = candidateGeometry(states[index]);
        if (geometry.eligible) {
          activeState = states[index];
          activeGeometry = geometry;
        }
      }

      for (var stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
        if (states[stateIndex] === activeState) {
          showState(states[stateIndex], activeGeometry);
        } else {
          hideState(states[stateIndex]);
        }
      }
    }

    function scheduleRefresh(shouldMeasure) {
      measureRequested = measureRequested || Boolean(shouldMeasure);
      if (frameScheduled) { return; }
      frameScheduled = true;
      window.requestAnimationFrame(refresh);
    }

    $shells.each(function(){
      if ($(this).data(STATE_KEY)) { return; }
      var state = buildState(this);
      if (!state) { return; }
      states.push(state);
      $(state.container).on('scroll' + EVENT_NAMESPACE, function(){
        scheduleRefresh(false);
      });
    });

    if (!states.length) { return; }

    $(window)
      .on('scroll' + EVENT_NAMESPACE, function(){ scheduleRefresh(false); })
      .on('resize' + EVENT_NAMESPACE, function(){ scheduleRefresh(true); });

    if (window.ResizeObserver) {
      var resizeObserver = new window.ResizeObserver(function(){
        scheduleRefresh(true);
      });
      for (var index = 0; index < states.length; index += 1) {
        resizeObserver.observe(states[index].container);
        resizeObserver.observe(states[index].sourceTable);
      }
    }

    scheduleRefresh(true);
  });
})();


$(document).ready(function(){

  $('[data-tom-color-picker] a')
    .on('click', function(e){
      e.stopPropagation();

      // Close dropdown
      $(e.target).closest('.dropdown-menu').dropdown('toggle');

      var new_class_name =  $(e.target).data('tom-color-picker-css-class');

      // Ensure newly selected color is on triggering element
      $(e.target).closest('[data-tom-color-picker]')
        .find('button.dropdown-toggle')
        .attr('class', function(idx, c){ return c.replace(/leave_type_color_\d+/g, '') })
        .addClass( new_class_name );

      // Capture newly picked up color in hidden input for submission
      $(e.target).closest('[data-tom-color-picker]')
        .find('input[type="hidden"]')
        .attr('value', new_class_name);

      return false;
    });
});

$(document).ready(function(){
  var translations = (window.timeoff && window.timeoff.translations) || {};

  function sidePopoverPlacement(tip, element) {
    var elementRect = element.getBoundingClientRect();
    var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    var popoverWidth = tip && tip.offsetWidth ? tip.offsetWidth : 320;

    return elementRect.right + popoverWidth + 24 > viewportWidth ? 'left' : 'right';
  }

  /*
    Employee summary popovers.

    Two separate initializations, keyed by marker class so every interactive
    employee-summary trigger (a real <button> on Requests and Team View) is
    fully keyboard/click driven, while any remaining legacy user-details
    trigger that has not been migrated yet keeps the original hover-only
    behaviour:

      .interactive-user-details-summary-trigger  -> manual controller
      .user-details-summary-trigger (legacy)     -> Bootstrap hover popover

    Bootstrap still owns aria-describedby and the .popover[role=tooltip]
    element in both cases.
  */

  // --- Shared placement helper used by both branches above and below. ---
  // (sidePopoverPlacement is already defined at the top of this ready block.)

  /*
    Legacy user-details triggers that have not been migrated to the manual
    controller yet: original hover-only behaviour. No manual state, no
    click/focus handlers, no pointerPinned. Any element carrying the
    interactive marker is excluded so it is not double-initialised.
  */
  var $legacyUserTriggers = $('.user-details-summary-trigger')
    .not('.interactive-user-details-summary-trigger');

  if ($legacyUserTriggers.length) {
    $legacyUserTriggers.popover({
      title: translations.employeeSummary,
      container: 'body',
      html: true,
      trigger: 'hover',
      placement: sidePopoverPlacement,
      viewport: { selector: 'body', padding: 12 },
      delay: { show: 700, hide: 120 },
      content: function(){
        var $trigger = $(this);
        var $content = $('<div>', {
          'class': 'employee-summary-popover-content',
          'text': translations.loading
        });
        $.ajax({
          url: '/users/summary/' + $trigger.attr('data-user-id') + '/',
          success: function(response){ $content.html(response); },
          error: function(){ $content.text(translations.requestFailed); }
        });
        return $content[0];
      }
    });
  }

  /*
    Interactive employee-summary triggers (Requests button, Team View
    button): manual controller.
  */
  var $interactiveUserTriggers = $('.interactive-user-details-summary-trigger');

  if ($interactiveUserTriggers.length) {
    var SHOW_DELAY_HOVER = 700;
    var HIDE_DELAY = 120;

    // One shared document-level Escape handler for interactive popovers only.
    var ESCAPE_NS = 'keydown.userSummaryPopover';
    $(document).off(ESCAPE_NS).on(ESCAPE_NS, function(e){
      if (e.which !== 27) { return; }
      var current = currentOpen();
      if (!current) { return; }
      // Only act when our popover is the relevant one; let modal/dropdown
      // handle Escape themselves otherwise.
      hideTrigger(current);
    });

    // One shared document-level click handler for click-outside.
    var CLICK_NS = 'click.userSummaryPopover';
    $(document).off(CLICK_NS).on(CLICK_NS, function(e){
      $interactiveUserTriggers.each(function(){
        var $t = $(this);
        var state = $t.data('userSummaryState');
        if (!state || !state.pointerPinned) { return; }
        var insideTrigger = $.contains(this, e.target) || this === e.target;
        var tip = tipOf($t);
        var insidePopover = tip && ($.contains(tip, e.target) || tip === e.target);
        // Click on the trigger itself is handled by the trigger's own
        // click handler (toggle); do not double-process here.
        if (!insideTrigger && !insidePopover) {
          hideTrigger($t);
        }
      });
    });

    function tipOf($trigger) {
      var inst = $trigger.data('bs.popover');
      return inst && inst.tip ? inst.tip() : null;
    }

    function isOpen($trigger) {
      var tip = tipOf($trigger);
      return !!(tip && tip.is(':visible'));
    }

    function currentOpen() {
      var found = null;
      $interactiveUserTriggers.each(function(){
        if (isOpen($(this))) { found = $(this); }
      });
      return found;
    }

    function cancelShow(state) {
      if (state.showTimer) {
        window.clearTimeout(state.showTimer);
        state.showTimer = null;
      }
    }

    function cancelHide(state) {
      if (state.hideTimer) {
        window.clearTimeout(state.hideTimer);
        state.hideTimer = null;
      }
    }

    function shouldStayVisible(state) {
      return state.hovered || state.focused || state.pointerPinned || state.popoverHovered;
    }

    // Deactivate every OTHER requests employee-summary trigger, including
    // ones whose popover is still pending (showTimer set but not yet shown).
    // hideTrigger already cancels showTimer/hideTimer, clears pointerPinned,
    // aborts the trigger's in-flight XHR, and hides a visible popover, so it
    // is safe to call on a trigger that has not become visible yet. We do
    // NOT reset `hovered`/`focused` here: those reflect real pointer/keyboard
    // state and must stay consistent with subsequent native events.
    function hideOtherTriggers($activeTrigger) {
      $interactiveUserTriggers.each(function(){
        var $other = $(this);
        if ($other.is($activeTrigger)) {
          return;
        }
        hideTrigger($other);
      });
    }

    // Centralised open routine: cancel any pending timers, deactivate every
    // OTHER requests employee-summary trigger (visible or pending), and show
    // this one exactly once.
    function showTrigger($trigger) {
      var state = $trigger.data('userSummaryState');
      cancelShow(state);
      cancelHide(state);
      hideOtherTriggers($trigger);
      if (!isOpen($trigger)) {
        $trigger.popover('show');
      }
    }

    function scheduleShow($trigger, delay) {
      var state = $trigger.data('userSummaryState');
      cancelHide(state);
      if (isOpen($trigger)) { return; }
      if (state.showTimer) { return; }
      state.showTimer = window.setTimeout(function(){
        state.showTimer = null;
        showTrigger($trigger);
      }, delay);
    }

    function scheduleHide($trigger) {
      var state = $trigger.data('userSummaryState');
      cancelShow(state);
      if (state.hideTimer) { return; }
      state.hideTimer = window.setTimeout(function(){
        state.hideTimer = null;
        if (!shouldStayVisible(state)) {
          $trigger.popover('hide');
        }
      }, HIDE_DELAY);
    }

    function hideTrigger($trigger) {
      var state = $trigger.data('userSummaryState');
      cancelShow(state);
      cancelHide(state);
      state.pointerPinned = false;
      state.popoverHovered = false;
      if (state.currentXhr) {
        state.currentXhr.abort();
        // state.currentXhr is cleared by the xhr's own complete callback,
        // guarded by identity (see below).
      }
      if (isOpen($trigger)) {
        $trigger.popover('hide');
      }
    }

    function bindPopoverHover($trigger) {
      var $tip = tipOf($trigger);
      if (!$tip || $tip.data('userSummaryHoverBound')) { return; }
      $tip
        .on('mouseenter.userSummaryPopover', function(){
          var state = $trigger.data('userSummaryState');
          state.popoverHovered = true;
          cancelHide(state);
        })
        .on('mouseleave.userSummaryPopover', function(){
          var state = $trigger.data('userSummaryState');
          state.popoverHovered = false;
          scheduleHide($trigger);
        })
        .data('userSummaryHoverBound', true);
    }

    $interactiveUserTriggers.each(function(){
      var $trigger = $(this);
      // AJAX content object lives on the trigger; response can only land here.
      var $content = $('<div>', {
        'class': 'employee-summary-popover-content',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        'text': translations.loading
      });

      var state = {
        hovered: false,
        focused: false,
        pointerPinned: false,
        popoverHovered: false,
        showTimer: null,
        hideTimer: null,
        currentXhr: null,
        content: $content
      };
      $trigger.data('userSummaryState', state);

      $trigger.popover({
        title: translations.employeeSummary,
        container: 'body',
        html: true,
        trigger: 'manual',
        placement: sidePopoverPlacement,
        viewport: { selector: 'body', padding: 12 },
        content: function(){ return $content[0]; }
      });

      // Once the popover element exists, attach hover handlers to its tip
      // so the user can move the pointer onto the popover without losing it.
      $trigger.on('shown.bs.popover', function(){
        bindPopoverHover($trigger);
      });

      $trigger
        .on('mouseenter.userSummaryPopover', function(){
          state.hovered = true;
          scheduleShow($trigger, SHOW_DELAY_HOVER);
        })
        .on('mouseleave.userSummaryPopover', function(){
          state.hovered = false;
          scheduleHide($trigger);
        })
        .on('focusin.userSummaryPopover', function(){
          state.focused = true;
          // Keyboard focus shows immediately: 700ms delay is tuned for
          // accidental hover and is painful for keyboard users.
          scheduleShow($trigger, 0);
        })
        .on('focusout.userSummaryPopover', function(){
          state.focused = false;
          scheduleHide($trigger);
        })
        .on('click.userSummaryPopover', function(e){
          // Distinguish pointer activation (mouse/touch) from keyboard
          // activation (Enter/Space synthesizes a click with detail=0 and,
          // for Enter, without a preceding pointerdown). detail === 0 means
          // keyboard; the popover is already open from focusin.
          var fromKeyboard = (e.detail === 0);
          if (fromKeyboard) {
            // Keyboard click is NOT a toggle:
            //  - if already open: keep it open (no change);
            //  - if closed (e.g. after Escape, while focus is still here):
            //    open immediately without a toggle that could hide it again.
            e.preventDefault();
            if (!isOpen($trigger)) {
              showTrigger($trigger);
            }
            return;
          }
          e.preventDefault();
          if (state.pointerPinned) {
            hideTrigger($trigger);
          } else {
            // A real pointer click on the button first fires focusin, which
            // calls scheduleShow(0). Cancel both timers so the show happens
            // exactly once, through showTrigger.
            state.pointerPinned = true;
            showTrigger($trigger);
          }
        });

      // Load AJAX content when the popover is first shown.
      $trigger.on('show.bs.popover', function(){
        // Abort a previous in-flight request for this trigger, if any.
        if (state.currentXhr) {
          state.currentXhr.abort();
        }
        $content.text(translations.loading);
        // Capture this specific request and compare by identity in every
        // callback so a late response from an older request can never
        // overwrite the content of a newer popover.
        var xhr = $.ajax({
          url: '/users/summary/' + $trigger.attr('data-user-id') + '/',
          success: function(response){
            if (state.currentXhr !== xhr) { return; }
            $content.html(response);
          },
          error: function(jqXhr, textStatus){
            // textStatus === 'abort' happens when we intentionally cancel
            // a stale request — do not surface a failure message for that.
            if (textStatus === 'abort') { return; }
            if (state.currentXhr !== xhr) { return; }
            $content.text(translations.requestFailed);
          },
          complete: function(){
            if (state.currentXhr === xhr) {
              state.currentXhr = null;
            }
          }
        });
        state.currentXhr = xhr;
      });
    });
  }
});

$(document).ready(function(){
  var translations = (window.timeoff && window.timeoff.translations) || {};

  function sidePopoverPlacement(tip, element) {
    var elementRect = element.getBoundingClientRect();
    var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    var popoverWidth = tip && tip.offsetWidth ? tip.offsetWidth : 320;

    if (tip && tip.style) {
      tip.style.width = '';
      tip.style.minWidth = '';
      tip.style.maxWidth = '';
      tip.style.maxHeight = '';
      tip.style.overflowY = '';
    }
    if (viewportWidth < 560) {
      var leftSpace = Math.max(0, elementRect.left - 12);
      var rightSpace = Math.max(0, viewportWidth - elementRect.right - 12);
      var availableSideSpace = Math.max(leftSpace, rightSpace);
      if (tip && tip.style) {
        var mobilePopoverWidth = Math.max(72, availableSideSpace) + 'px';
        tip.style.width = mobilePopoverWidth;
        tip.style.minWidth = mobilePopoverWidth;
        tip.style.maxWidth = mobilePopoverWidth;
        tip.style.maxHeight = Math.max(120, window.innerHeight - 24) + 'px';
        tip.style.overflowY = 'auto';
      }
      return rightSpace >= leftSpace ? 'right' : 'left';
    }
    return elementRect.right + popoverWidth + 24 > viewportWidth ? 'left' : 'right';
  }

  (function initInteractiveDeductedDaysPopovers() {
    var $interactiveDeductedDaysTriggers = $('.interactive-teamview-deducted-days-trigger');

    if (!$interactiveDeductedDaysTriggers.length) {
      return;
    }

    var SHOW_DELAY_HOVER = 700;
    var HIDE_DELAY = 120;
    var ESCAPE_NS = 'keydown.deductedDaysPopover';
    var CLICK_NS = 'click.deductedDaysPopover';

    function tipOf($trigger) {
      var instance = $trigger.data('bs.popover');
      return instance && instance.tip ? instance.tip() : null;
    }

    function isOpen($trigger) {
      var tip = tipOf($trigger);
      return !!(tip && tip.is(':visible'));
    }

    function currentOpen() {
      var found = null;
      $interactiveDeductedDaysTriggers.each(function() {
        if (isOpen($(this))) {
          found = $(this);
        }
      });
      return found;
    }

    function cancelShow(state) {
      if (!state.showTimer) {
        return;
      }
      window.clearTimeout(state.showTimer);
      state.showTimer = null;
    }

    function cancelHide(state) {
      if (!state.hideTimer) {
        return;
      }
      window.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }

    function shouldStayVisible(state) {
      return state.hovered
        || state.focused
        || state.pointerPinned
        || state.popoverHovered;
    }

    function hideTrigger($trigger) {
      var state = $trigger.data('deductedDaysPopoverState');
      if (!state) {
        return;
      }
      cancelShow(state);
      cancelHide(state);
      state.pointerPinned = false;
      state.popoverHovered = false;
      if (isOpen($trigger)) {
        $trigger.popover('hide');
      }
    }

    function hideOtherTriggers($activeTrigger) {
      $interactiveDeductedDaysTriggers.each(function() {
        var $other = $(this);
        if (!$other.is($activeTrigger)) {
          hideTrigger($other);
        }
      });
    }

    function showTrigger($trigger) {
      var state = $trigger.data('deductedDaysPopoverState');
      cancelShow(state);
      cancelHide(state);
      hideOtherTriggers($trigger);
      if (!isOpen($trigger)) {
        $trigger.popover('show');
      }
    }

    function scheduleShow($trigger, delay) {
      var state = $trigger.data('deductedDaysPopoverState');
      cancelHide(state);
      if (isOpen($trigger) || state.showTimer) {
        return;
      }
      state.showTimer = window.setTimeout(function() {
        state.showTimer = null;
        showTrigger($trigger);
      }, delay);
    }

    function scheduleHide($trigger) {
      var state = $trigger.data('deductedDaysPopoverState');
      cancelShow(state);
      if (state.hideTimer) {
        return;
      }
      state.hideTimer = window.setTimeout(function() {
        state.hideTimer = null;
        if (!shouldStayVisible(state)) {
          hideTrigger($trigger);
        }
      }, HIDE_DELAY);
    }

    function bindPopoverHover($trigger) {
      var $tip = tipOf($trigger);
      if (!$tip || $tip.data('deductedDaysPopoverHoverBound')) {
        return;
      }
      $tip
        .on('mouseenter.deductedDaysPopover', function() {
          var state = $trigger.data('deductedDaysPopoverState');
          state.popoverHovered = true;
          cancelHide(state);
        })
        .on('mouseleave.deductedDaysPopover', function() {
          var state = $trigger.data('deductedDaysPopoverState');
          state.popoverHovered = false;
          scheduleHide($trigger);
        })
        .data('deductedDaysPopoverHoverBound', true);
    }

    $(document).off(ESCAPE_NS).on(ESCAPE_NS, function(e) {
      if (e.which !== 27) {
        return;
      }
      var current = currentOpen();
      if (current) {
        hideTrigger(current);
      }
    });

    $(document).off(CLICK_NS).on(CLICK_NS, function(e) {
      $interactiveDeductedDaysTriggers.each(function() {
        var $trigger = $(this);
        var state = $trigger.data('deductedDaysPopoverState');
        if (!state || !state.pointerPinned) { return; }

        var insideTrigger = this === e.target || $.contains(this, e.target);
        var tip = tipOf($trigger);
        var tipElement = tip && tip[0];
        var insidePopover = tipElement && (
          tipElement === e.target || $.contains(tipElement, e.target)
        );

        if (!insideTrigger && !insidePopover) {
          hideTrigger($trigger);
        }
      });
    });

    $interactiveDeductedDaysTriggers.each(function() {
      var $trigger = $(this);
      var state = {
        hovered: false,
        focused: false,
        pointerPinned: false,
        popoverHovered: false,
        showTimer: null,
        hideTimer: null
      };

      $trigger.data('deductedDaysPopoverState', state);
      $trigger.popover({
        container: 'body',
        html: false,
        trigger: 'manual',
        placement: sidePopoverPlacement,
        viewport: { selector: 'body', padding: 12 },
        content: function() {
          return $trigger.attr('data-content') || '';
        }
      });

      $trigger
        .on('shown.bs.popover.deductedDaysPopover', function() {
          $trigger.attr('aria-expanded', 'true');
          bindPopoverHover($trigger);
        })
        .on('hidden.bs.popover.deductedDaysPopover', function() {
          $trigger.attr('aria-expanded', 'false');
        })
        .on('mouseenter.deductedDaysPopover', function() {
          state.hovered = true;
          scheduleShow($trigger, SHOW_DELAY_HOVER);
        })
        .on('mouseleave.deductedDaysPopover', function() {
          state.hovered = false;
          scheduleHide($trigger);
        })
        .on('focusin.deductedDaysPopover', function() {
          state.focused = true;
          scheduleShow($trigger, 0);
        })
        .on('focusout.deductedDaysPopover', function() {
          state.focused = false;
          state.pointerPinned = false;
          scheduleHide($trigger);
        })
        .on('pointerdown.deductedDaysPopover', function() {
          state.pointerDown = true;
        })
        .on('click.deductedDaysPopover', function(e) {
          var fromKeyboard = e.detail === 0 || !state.pointerDown;
          state.pointerDown = false;
          e.preventDefault();

          if (fromKeyboard) {
            if (!isOpen($trigger)) {
              showTrigger($trigger);
            }
            return;
          }

          if (state.pointerPinned) {
            hideTrigger($trigger);
          } else {
            state.pointerPinned = true;
            showTrigger($trigger);
          }
        });
    });
  })();

  var $interactiveLeaveTriggers = $('.interactive-leave-details-summary-trigger');

  if ($interactiveLeaveTriggers.length) {
    var SHOW_DELAY_HOVER = 700;
    var HIDE_DELAY = 120;
    var ESCAPE_NS = 'keydown.leaveSummaryPopover';
    var CLICK_NS = 'click.leaveSummaryPopover';

    $(document).off(ESCAPE_NS).on(ESCAPE_NS, function(e){
      if (e.which !== 27) { return; }
      var current = currentOpen();
      if (!current) { return; }
      hideTrigger(current);
    });

    $(document).off(CLICK_NS).on(CLICK_NS, function(e){
      $interactiveLeaveTriggers.each(function(){
        var $trigger = $(this);
        var state = $trigger.data('leaveSummaryState');
        if (!state || !state.pointerPinned) { return; }
        var insideTrigger = this === e.target || $.contains(this, e.target);
        var tip = tipOf($trigger);
        var tipElement = tip && tip[0];
        var insidePopover = tipElement && (
          tipElement === e.target || $.contains(tipElement, e.target)
        );

        if (!insideTrigger && !insidePopover) {
          hideTrigger($trigger);
        }
      });
    });

    function tipOf($trigger) {
      var instance = $trigger.data('bs.popover');
      return instance && instance.tip ? instance.tip() : null;
    }

    function isOpen($trigger) {
      var tip = tipOf($trigger);
      return !!(tip && tip.is(':visible'));
    }

    function currentOpen() {
      var found = null;
      $interactiveLeaveTriggers.each(function(){
        if (isOpen($(this))) { found = $(this); }
      });
      return found;
    }

    function cancelShow(state) {
      if (!state.showTimer) { return; }
      window.clearTimeout(state.showTimer);
      state.showTimer = null;
    }

    function cancelHide(state) {
      if (!state.hideTimer) { return; }
      window.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }

    function shouldStayVisible(state) {
      return state.hovered || state.focused || state.pointerPinned || state.popoverHovered;
    }

    function hideOtherTriggers($activeTrigger) {
      $interactiveLeaveTriggers.each(function(){
        var $other = $(this);
        if (!$other.is($activeTrigger)) {
          hideTrigger($other);
        }
      });
    }

    function showTrigger($trigger) {
      var state = $trigger.data('leaveSummaryState');
      cancelShow(state);
      cancelHide(state);
      hideOtherTriggers($trigger);
      if (!isOpen($trigger)) {
        $trigger.popover('show');
      }
    }

    function scheduleShow($trigger, delay) {
      var state = $trigger.data('leaveSummaryState');
      cancelHide(state);
      if (isOpen($trigger) || state.showTimer) { return; }
      state.showTimer = window.setTimeout(function(){
        state.showTimer = null;
        showTrigger($trigger);
      }, delay);
    }

    function scheduleHide($trigger) {
      var state = $trigger.data('leaveSummaryState');
      cancelShow(state);
      if (state.hideTimer) { return; }
      state.hideTimer = window.setTimeout(function(){
        state.hideTimer = null;
        if (!shouldStayVisible(state)) {
          hideTrigger($trigger);
        }
      }, HIDE_DELAY);
    }

    function hideTrigger($trigger) {
      var state = $trigger.data('leaveSummaryState');
      if (!state) { return; }
      cancelShow(state);
      cancelHide(state);
      state.pointerPinned = false;
      state.popoverHovered = false;
      if (state.currentXhr) {
        state.currentXhr.abort();
      }
      if (isOpen($trigger)) {
        $trigger.popover('hide');
      }
    }

    function bindPopoverHover($trigger) {
      var $tip = tipOf($trigger);
      if (!$tip || $tip.data('leaveSummaryHoverBound')) { return; }
      $tip
        .on('mouseenter.leaveSummaryPopover', function(){
          var state = $trigger.data('leaveSummaryState');
          state.popoverHovered = true;
          cancelHide(state);
        })
        .on('mouseleave.leaveSummaryPopover', function(){
          var state = $trigger.data('leaveSummaryState');
          state.popoverHovered = false;
          scheduleHide($trigger);
        })
        .data('leaveSummaryHoverBound', true);
    }

    $interactiveLeaveTriggers.each(function(){
      var $trigger = $(this);
      var $content = $('<div>', {
        'class': 'leave-summary-popover-content',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        'text': translations.loading
      });
      var state = {
        hovered: false,
        focused: false,
        pointerPinned: false,
        popoverHovered: false,
        showTimer: null,
        hideTimer: null,
        currentXhr: null,
        content: $content
      };

      $trigger.data('leaveSummaryState', state);
      $trigger.popover({
        title: translations.leaveSummary,
        container: 'body',
        html: true,
        trigger: 'manual',
        placement: sidePopoverPlacement,
        viewport: { selector: 'body', padding: 12 },
        content: function(){ return $content[0]; }
      });

      $trigger
        .on('shown.bs.popover.leaveSummaryPopover', function(){
          $trigger.attr('aria-expanded', 'true');
          bindPopoverHover($trigger);
        })
        .on('hidden.bs.popover.leaveSummaryPopover', function(){
          $trigger.attr('aria-expanded', 'false');
        })
        .on('mouseenter.leaveSummaryPopover', function(){
          state.hovered = true;
          scheduleShow($trigger, SHOW_DELAY_HOVER);
        })
        .on('mouseleave.leaveSummaryPopover', function(){
          state.hovered = false;
          scheduleHide($trigger);
        })
        .on('focusin.leaveSummaryPopover', function(){
          state.focused = true;
          scheduleShow($trigger, 0);
        })
        .on('focusout.leaveSummaryPopover', function(){
          state.focused = false;
          scheduleHide($trigger);
        })
        .on('click.leaveSummaryPopover', function(e){
          var fromKeyboard = e.detail === 0;
          e.preventDefault();

          if (fromKeyboard) {
            if (!isOpen($trigger)) {
              showTrigger($trigger);
            }
            return;
          }

          if (state.pointerPinned) {
            hideTrigger($trigger);
          } else {
            state.pointerPinned = true;
            showTrigger($trigger);
          }
        })
        .on('show.bs.popover.leaveSummaryPopover', function(){
          if (state.currentXhr) {
            state.currentXhr.abort();
          }
          $content.text(translations.loading);
          var xhr = $.ajax({
            url: '/calendar/leave-summary/' + $trigger.attr('data-leave-id') + '/',
            success: function(response){
              if (state.currentXhr !== xhr) { return; }
              $content.html(response);
            },
            error: function(jqXhr, textStatus){
              if (state.currentXhr !== xhr || textStatus === 'abort') { return; }
              $content.text(translations.requestFailed);
            },
            complete: function(){
              if (state.currentXhr === xhr) {
                state.currentXhr = null;
              }
            }
          });
          state.currentXhr = xhr;
        });
    });
  }
});

$(document).ready(function() {
  var translations = (window.timeoff && window.timeoff.translations) || {};

  if (
    window.navigator.webdriver ||
    (window.timeoff && window.timeoff.disableNotifications) ||
    !$('#header-notification-dropdown').length
  ) {
    return;
  }

  const fetchNotifications = () => {
    if (typeof($.ajax) === 'function') {
      $.ajax({
        url: '/api/v1/notifications/',
        success: function(args){
          const error = args.error;
          const data = args.data;

          if (error) {
            console.log('Failed to fetch notifications');
            return;
          }

          const dropDown = $('#header-notification-dropdown ul.dropdown-menu');
          const badge = $('#header-notification-dropdown .notification-badge');
          const featureBadges = $('.notification-feature-badge');

          featureBadges.addClass('hidden').text('');
          (data || []).forEach(function(notification) {
            if (!notification.badgeId) {
              return;
            }

            $('#' + notification.badgeId)
              .removeClass('hidden')
              .text(notification.numberOfRequests);
          });

          if (!data || !data.length) {
            badge.addClass('hidden');
            dropDown.empty();
            dropDown.append('<li class="dropdown-header">' + translations.notificationsEmpty + '</li>')

            document.title = document.title.replace(/\(\d+\)\s*/, '');

            return;
          }

          const numberOfNotifications = data
            .map(function(d) {return d.numberOfRequests})
            .reduce(function(acc, it){ return acc + it}, 0)

          badge.removeClass('hidden').html(numberOfNotifications);

          if (!document.title.startsWith('(')) {
            document.title = '(' + numberOfNotifications + ') ' + document.title;
          } else {
            document.title = document.title.replace(/\(\d+\)/, '('+numberOfNotifications+')');
          }

          dropDown.empty();

          for (var i=0; i<data.length; i++) {
            const notification = data[i];
            dropDown.append(
              '<li><a href="'+notification.link+'">'+notification.label+'</a></li>'
            );
          }
        },
        error: function(){
          console.log('Failed to fetch notifications');
        }
      });
    }

    setTimeout(fetchNotifications, 30 * 1000);
  }

  fetchNotifications();
});

/**
 * Prevent for double submission.
 */
$(document).ready(function(){
  $('.single-click').on('click', function(e) {
    var button = e.currentTarget;
    var form = $(button).closest('form');
    var formElement = form.get(0);

    // Leave invalid submissions to the browser's native validation flow.
    if (!formElement || !formElement.checkValidity()) {
      return;
    }

    e.stopPropagation();
    $(button).prop('disabled', true);

    var submitName = $(button).attr('name');
    if (submitName !== undefined) {
      $('<input>').attr({type: 'hidden', name: submitName, value: '1'}).appendTo(form);
    }
    form.submit();

    return false;
  });
});

/*
 * Requests: contextual bulk decision controls.
 *
 * Selection stays native (checkboxes associated with the external form), while
 * this page-scoped controller keeps row feedback, the fixed action surface and
 * submit state in sync. The form action is copied from the activated submit
 * button before controls are disabled so approve/reject keep their dedicated
 * endpoints without relying on a disabled submitter's `formaction`.
 */
$(document).ready(function(){
  var $form = $('#bulk-action-form');
  if (!$form.length) { return; }

  var $page = $('.requests-page');
  var $selectAll = $('.bulk-select-all');
  var $checkboxes = $('.bulk-request-checkbox');
  var $actionButtons = $form.find('.bulk-approve-btn, .bulk-reject-btn');
  var $clearButton = $form.find('.bulk-clear-btn');
  var $counter = $form.find('.bulk-selected-count');
  var $status = $form.find('.bulk-action-status');
  var countTemplate = $form.attr('data-count-template') || '{count}';
  var processingTemplate = $form.attr('data-processing-template') || '';
  var submitting = false;
  var lastChangedCheckbox = null;

  function selectedCount() {
    return $checkboxes.filter(':checked').length;
  }

  function refreshRows() {
    $checkboxes.each(function(){
      $(this).closest('tr').toggleClass('is-selected', this.checked);
    });
  }

  function refresh() {
    var count = selectedCount();
    var hasSelection = count > 0;

    refreshRows();
    $form.prop('hidden', !hasSelection);
    $page.toggleClass('has-active-bulk-actions', hasSelection);
    $actionButtons.prop('disabled', !hasSelection || submitting);
    $clearButton.prop('disabled', submitting);
    $counter.text(hasSelection ? countTemplate.replace('{count}', count) : '');

    if ($selectAll.length) {
      $selectAll.prop('checked', count > 0 && count === $checkboxes.length);
      $selectAll.prop('indeterminate', count > 0 && count < $checkboxes.length);
    }
  }

  function keepRowAboveActions(checkbox) {
    if (!checkbox || !checkbox.checked) { return; }

    (window.requestAnimationFrame || function(callback) {
      window.setTimeout(callback, 16);
    })(function(){
      if ($form.prop('hidden')) { return; }

      var row = $(checkbox).closest('tr')[0];
      if (!row) { return; }

      var rowRect = row.getBoundingClientRect();
      var formRect = $form[0].getBoundingClientRect();
      var overlap = rowRect.bottom - (formRect.top - 8);

      if (overlap > 0) {
        window.scrollBy(0, overlap);
      }
    });
  }

  $selectAll.on('change.requestsBulkActions', function(){
    var checked = this.checked;
    $checkboxes.each(function(){ this.checked = checked; });
    lastChangedCheckbox = checked ? $checkboxes.first()[0] : null;
    refresh();
    keepRowAboveActions(lastChangedCheckbox);
  });

  $checkboxes.on('change.requestsBulkActions', function(){
    lastChangedCheckbox = this;
    refresh();
    keepRowAboveActions(this);
  });

  $clearButton.on('click.requestsBulkActions', function(){
    $checkboxes.prop('checked', false);
    refresh();
    if (lastChangedCheckbox) {
      $(lastChangedCheckbox).focus();
    } else if ($checkboxes.length) {
      $checkboxes.first().focus();
    }
  });

  $actionButtons.on('click.requestsBulkActions', function(event){
    if (submitting) {
      event.preventDefault();
      return;
    }

    var action = $(this).attr('formaction');
    if (action) {
      $form.attr('action', action);
    }
  });

  $form.on('submit.requestsBulkActions', function(event){
    var count = selectedCount();

    if (submitting || count === 0) {
      event.preventDefault();
      return;
    }

    submitting = true;
    $form.attr('aria-busy', 'true').addClass('is-submitting');
    $status.text(processingTemplate.replace('{count}', count));
    $actionButtons.prop('disabled', true).attr('aria-disabled', 'true');
    $clearButton.prop('disabled', true);
    $selectAll.prop('disabled', true);
  });

  function restoreInitialSelection() {
    lastChangedCheckbox = $checkboxes.filter(':checked').last()[0] || null;
    refresh();
    keepRowAboveActions(lastChangedCheckbox);
  }

  function restoreSelectionAfterPageShow() {
    window.setTimeout(restoreInitialSelection, 0);
  }

  $(window).on('pageshow.requestsBulkActions', restoreSelectionAfterPageShow);
  $(window).on('resize.requestsBulkActions', function(){
    keepRowAboveActions(lastChangedCheckbox);
  });
  $('.navbar-collapse').on(
    'hidden.bs.collapse.requestsBulkActions shown.bs.collapse.requestsBulkActions',
    function(){
      keepRowAboveActions(lastChangedCheckbox);
    }
  );
  restoreInitialSelection();
});

$(document).ready(function(){
  var $feedback = $('#requests-feedback[data-focus-alert-on-load] [role="alert"]').first();

  if ($feedback.length) {
    $feedback.attr('tabindex', '-1').focus();
  }
});

/*
 * Book leave modal: move focus to the first usable form control once shown.
 *
 * Bootstrap 3.3.4 already manages aria-hidden, the focus trap (enforceFocus),
 * Escape dismissal, and focus restoration to the opener, so this only chooses
 * a meaningful initial focus inside the dialog instead of leaving focus on the
 * modal container itself. Order matches the visible form: #employee (only
 * present for supervisors), then #leave_type, then the first focusable control.
 */
$(document).ready(function(){
  $('#book_leave_modal').on('shown.bs.modal', function() {
    var $modal = $(this);
    var $preferred = $modal.find('#employee').add($modal.find('#leave_type'));
    var $target = $preferred.filter(':visible').filter(function() {
      return !this.disabled;
    }).first();

    if (!$target.length) {
      $target = $modal.find('button, a[href], input, select, textarea')
        .filter(':visible').filter(function() {
          return !this.disabled && this.type !== 'hidden';
        }).first();
    }

    if ($target.length) {
      $target.focus();
    }
  });
});

$(document).ready(function(){
  var currentPath = window.location.pathname;

  $('.primary-navigation > li > a[href]').each(function(){
    var linkPath = this.pathname;
    var isTeamView = linkPath === '/calendar/teamview/';
    var isCurrent = isTeamView
      ? currentPath.indexOf('/calendar/teamview/') === 0
      : (linkPath === '/calendar/' ? currentPath === '/calendar/' : currentPath.indexOf(linkPath) === 0);

    if (isCurrent) {
      $(this).attr('aria-current', 'page').parent().addClass('active');
    }
  });

  $('.navbar-collapse a:not(.dropdown-toggle)').on('click', function(){
    if ($('.navbar-toggle').is(':visible')) {
      $('.navbar-collapse').collapse('hide');
    }
  });
});

$(document).ready(function(){
  var themeStorageKey = 'timeoff-theme';
  var $themeMenu = $('#theme-menu');

  if (!$themeMenu.length) {
    return;
  }

  var $themeLabel = $themeMenu.find('.theme-label');
  var $themeIcon = $themeMenu.find('.theme-icon');

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function setLabel(theme) {
    var $item = $themeMenu.find('[data-theme-value="' + theme + '"]');
    if ($item.length) {
      $themeLabel.text($item.text());
    }

    $themeIcon
      .toggleClass('fa-sun-o', theme !== 'dark')
      .toggleClass('fa-moon-o', theme === 'dark');
  }

  var storedTheme;
  try {
    storedTheme = localStorage.getItem(themeStorageKey);
  } catch (e) {
    storedTheme = null;
  }

  if (storedTheme === 'dark' || storedTheme === 'light') {
    applyTheme(storedTheme);
    setLabel(storedTheme);
  } else {
    applyTheme('light');
    setLabel('light');
  }

  $themeMenu.find('[data-theme-value]').on('click', function(event){
    event.preventDefault();
    var theme = $(this).data('theme-value');

    applyTheme(theme);
    setLabel(theme);

    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch (e) {
      // Ignore storage errors (for example, privacy mode).
    }
  });
});

/*
 * Primary navigation overflow.
 *
 * The primary row gets a fixed track between the brand and the utility
 * cluster, and an edition adds its own items to that track, so the row runs
 * out of room at ordinary laptop widths rather than exotic ones. The
 * stylesheet's answer is to let the track scroll, which keeps the bar on one
 * row but puts items behind a scrollbar that macOS does not draw until
 * something moves — the primary action button included. This measures the row
 * instead and moves whatever will not fit into a dropdown, so nothing is off
 * the screen without a control that points at it. A page with no JavaScript
 * keeps the scrolling track.
 */
$(document).ready(function () {
  var $nav = $('.primary-navigation');
  var $overflow = $nav.children('[data-nav-overflow]');

  if (!$nav.length || !$overflow.length) {
    return;
  }

  var nav = $nav.get(0);
  var anchor = $overflow.get(0);
  var $menu = $overflow.find('.nav-overflow-menu');
  var $badge = $overflow.find('.nav-overflow-badge');

  /*
    Items collapse from the end of the row, so the order an edition asked for
    is also the order in which its items survive on the bar. The action button
    is not a candidate at any width: it is the primary action of every page.
  */
  var collapsible = [];

  /*
    Bootstrap hides the hamburger above its own breakpoint, which is the same
    width at which the bar stops being a row, so its state doubles as the test
    for whether there is a row to measure at all.
  */
  var $navbarToggle = $('.navbar-toggle');

  function isRowLayout() {
    return $navbarToggle.length > 0 && $navbarToggle.css('display') === 'none';
  }

  /*
    Everything goes back on the bar before the row is read, and the candidate
    list is read back out of the DOM rather than remembered from the first
    pass, so an item added to the row after this ran is picked up too.
    Collapsing always takes from the end, which is what makes putting the
    restored items back in list order the same as putting them back where they
    were.
  */
  function restoreAll() {
    for (var index = 0; index < collapsible.length; index += 1) {
      if (collapsible[index].parentNode !== nav) {
        nav.insertBefore(collapsible[index], anchor);
      }
    }

    collapsible = $nav.children('li').not($overflow).not('.navbar-form').toArray();
  }

  /*
    Sub-pixel rounding leaves a stray pixel at some widths. One pixel is not a
    hidden item, and collapsing for it would move an item in and out of the
    menu on every resize.
  */
  function overflows() {
    return nav.scrollWidth - nav.clientWidth > 1;
  }

  function updateBadge() {
    var showing = $menu.find('.notification-feature-badge').not('.hidden');
    var total = 0;

    showing.each(function () {
      total += parseInt($(this).text(), 10) || 0;
    });

    $badge.text(total > 0 ? String(total) : '').toggleClass('is-visible', showing.length > 0);
  }

  function layout() {
    restoreAll();
    $overflow.addClass('hidden');

    if (!isRowLayout()) {
      updateBadge();
      return;
    }

    if (!collapsible.length || !overflows()) {
      updateBadge();
      return;
    }

    // Showing the toggle costs width of its own, so it goes on the bar before
    // anything is measured against it.
    $overflow.removeClass('hidden');

    var index = collapsible.length - 1;
    while (index >= 0 && overflows()) {
      $menu.prepend(collapsible[index]);
      index -= 1;
    }

    updateBadge();
  }

  var queued = false;

  function scheduleLayout() {
    if (queued) {
      return;
    }

    queued = true;

    var run = function () {
      queued = false;
      layout();
    };

    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 16);
    }
  }

  $nav.addClass('nav-overflow-managed');

  /*
    The badge an edition hangs off an item is switched on by the notification
    poll long after this runs, and by then the item may be inside the menu
    where nobody can see it.
  */
  if (window.MutationObserver) {
    new window.MutationObserver(updateBadge).observe($menu.get(0), {
      attributes: true,
      attributeFilter: ['class'],
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  $(window).on('resize orientationchange', scheduleLayout);

  // Web fonts and the icon font both land after this point and both move the
  // width of every label on the bar.
  $(window).on('load', scheduleLayout);

  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
    document.fonts.ready.then(scheduleLayout);
  }

  layout();
});

/*
  Modals and menus open from the control that summoned them.

  "If something disappears one way, we expect it to emerge from where it came."
  A dialog that scales up from the middle of the screen severs the link between
  the button pressed and the thing that appeared; one that grows out of that
  button keeps it. Same path on the way out, so it collapses back to where it
  came from.

  transform-origin is the whole mechanism, and it needs a real measurement:
  Bootstrap has not laid the dialog out yet when show.bs.modal fires, so the
  trigger is measured then and the origin applied on the next frame, once the
  dialog has a box. One frame out of a 300ms transition; the anchor holds for
  the rest of it.
*/
(function () {
  var ORIGIN_ATTRIBUTE = 'data-tom-origin';
  // Comfortably past Bootstrap's 150ms backdrop fade.
  var ANCHOR_DEADLINE_MS = 600;

  function anchorTo(dialog, trigger) {
    var target = trigger && trigger.getBoundingClientRect();

    if (!target || (!target.width && !target.height)) {
      dialog.style.transformOrigin = '';
      return true;
    }

    var box = dialog.getBoundingClientRect();

    if (!box.width && !box.height) {
      return false;
    }

    // Clamped to the dialog: a trigger far outside it would throw the scale
    // origin off-screen and read as a slide rather than a growth.
    var x = Math.max(0, Math.min(box.width, target.left + target.width / 2 - box.left));
    var y = Math.max(0, Math.min(box.height, target.top + target.height / 2 - box.top));
    var origin = Math.round(x) + 'px ' + Math.round(y) + 'px';

    dialog.style.transformOrigin = origin;
    dialog.setAttribute(ORIGIN_ATTRIBUTE, origin);

    return true;
  }

  $(document).on('show.bs.modal', '.modal', function (event) {
    var dialog = this.querySelector('.modal-dialog');
    var trigger = event.relatedTarget;

    if (!dialog) {
      return;
    }

    if (!trigger) {
      // Opened from script rather than a control: nothing to point at, so it
      // keeps the default centre rather than pointing somewhere arbitrary.
      dialog.style.transformOrigin = '';
      dialog.removeAttribute(ORIGIN_ATTRIBUTE);
      return;
    }

    /*
      The dialog is not measurable for a while yet. Bootstrap does not call
      show() on the modal until its backdrop has finished fading, so the dialog
      sits inside a display:none parent and measures 0x0 for the whole of that
      - traced on a real open as zero across six straight frames, then a box
      once the backdrop settled.

      So this waits on the measurement rather than on a frame count, up to a
      deadline. A dialog that never gets a box is one that never opened, and
      retrying past that would leave a loop running behind a closed modal.
    */
    var frame = window.requestAnimationFrame || function (callback) { return setTimeout(callback, 16); };
    var deadline = Date.now() + ANCHOR_DEADLINE_MS;

    (function attempt() {
      frame(function () {
        if (anchorTo(dialog, trigger) || Date.now() > deadline) {
          return;
        }

        attempt();
      });
    })();
  });

  // The origin set on the way in is left in place, so the dialog leaves along
  // the path it arrived on rather than collapsing to its centre.
  $(document).on('hidden.bs.modal', '.modal', function () {
    var dialog = this.querySelector('.modal-dialog');

    if (dialog) {
      dialog.style.transformOrigin = '';
      dialog.removeAttribute(ORIGIN_ATTRIBUTE);
    }
  });
})();

/*
  The last thing asked for is what happens.

  Bootstrap decides show/hide synchronously but finishes on a transition that
  lands later, and the late half acts on the intent that was current when it was
  scheduled. Interrupt a close by pressing the trigger again and the sequence
  measured is:

    show > hide > show > hidden > shown > shown > hidden

  Two shown events, a hidden after a show, and a modal that ends up closed
  although opening was the last thing requested: the user presses the button
  during the closing animation and nothing opens.

  Correcting on the events alone is not enough, and produced something worse -
  .in set while display stayed none. Bootstrap's show() returns early when it
  believes the modal is already shown, and after this race it does believe that
  while hideModal() has already hidden the element. So the correction reads its
  state rather than guessing at it, and clears the flag that would make the
  retry a no-op.

  The animation itself is untouched. It already interpolates from wherever it
  is: interrupting a close and reopening measured 0.97 -> 0.97 -> 1, with no
  jump back to the starting scale.
*/
(function () {
  var WANTED = 'tomModalWanted';
  var CORRECTING = 'tomModalCorrecting';

  function state(element) {
    return $(element).data('bs.modal');
  }

  function record(element, wanted) {
    $(element).data(WANTED, wanted);
  }

  function settledState(element) {
    // What the element is, not what Bootstrap thinks: after an interrupted
    // close these disagree, and the element is the one the reader sees.
    return element.classList.contains('in') && getComputedStyle(element).display !== 'none'
      ? 'shown'
      : 'hidden';
  }

  function reconcile(element) {
    var $element = $(element);
    var wanted = $element.data(WANTED);

    if (!wanted) {
      return;
    }

    if (wanted === settledState(element)) {
      $element.data(CORRECTING, false);
      return;
    }

    /*
      One correction, then leave it alone. Every correction settles into another
      shown/hidden, which asks for another - measured as six state changes for a
      single interruption, and app code listening on shown.bs.modal ran on each
      of them. If one retry does not land it, retrying harder will not either.
    */
    if ($element.data(CORRECTING)) {
      return;
    }

    $element.data(CORRECTING, true);

    var internals = state(element);

    if (internals) {
      // Left true by a show() that raced a hide, which makes the retry below a
      // no-op and strands the dialog with .in on a hidden element.
      internals.isShown = (wanted !== 'shown');
    }

    $(element).modal(wanted === 'shown' ? 'show' : 'hide');
  }

  // Reconciled on a frame after the event, so Bootstrap has finished writing
  // whatever it was going to write before its work is read back.
  function reconcileSoon(element) {
    var frame = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
    frame(function () { reconcile(element); });
  }

  $(document)
    .on('show.bs.modal', '.modal', function () { record(this, 'shown'); })
    .on('hide.bs.modal', '.modal', function () { record(this, 'hidden'); })
    .on('shown.bs.modal', '.modal', function () { reconcileSoon(this); })
    .on('hidden.bs.modal', '.modal', function () { reconcileSoon(this); });
})();
