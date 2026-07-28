// Live leave-balance forecast for the booking modal.
//
// As the employee chooses a leave type and dates, this asks the server how many
// days would be deducted and how many would remain, then renders a short hint
// inside the modal. Purely informational; the actual validation still happens
// on submit.
(function($) {
  'use strict';

  $(function() {
    var $forecast = $('.book-leave-forecast');
    if (!$forecast.length) { return; }

    var $form = $forecast.closest('form');
    if (!$form.length) { return; }

    var url = $forecast.data('forecast-url');
    var templates = {
      summary     : String($forecast.data('tpl-summary') || ''),
      exceed      : String($forecast.data('tpl-exceed') || ''),
      noAllowance : String($forecast.data('tpl-no-allowance') || ''),
      spansYears  : String($forecast.data('tpl-spans-years') || '')
    };

    var $leaveType = $form.find('#leave_type');
    var $from = $form.find('input[name="from_date"]');
    var $to = $form.find('input[name="to_date"]');
    var $fromPart = $form.find('select[name="from_date_part"]');
    var $toPart = $form.find('select[name="to_date_part"]');
    var $employee = $form.find('#employee');

    var csrfToken = (window.timeoff && window.timeoff.csrfToken) || '';
    var debounceTimer = null;
    var requestSeq = 0;

    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, function(match, key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
      });
    }

    // Render a number without trailing ".0" so "1.5" and "3" both look natural.
    function fmt(n) {
      return (Math.round(n * 100) / 100).toString();
    }

    function hide() {
      $forecast.attr('hidden', 'hidden').empty()
        .removeClass('alert-info alert-warning alert-danger');
    }

    function show(message, level) {
      $forecast
        .removeClass('alert-info alert-warning alert-danger')
        .addClass('alert-' + (level || 'info'))
        .text(message)
        .removeAttr('hidden');
    }

    function render(data) {
      if (!data || !data.ok) {
        hide();
        return;
      }

      if (!data.uses_allowance) {
        show(templates.noAllowance, 'info');
        return;
      }

      var values = {
        deducted  : fmt(data.deducted),
        remaining : fmt(data.remaining),
        available : fmt(data.available)
      };

      if (data.would_exceed) {
        show(fill(templates.exceed, values), 'danger');
        return;
      }

      var message = fill(templates.summary, values);
      if (data.spans_years && templates.spansYears) {
        message += ' ' + templates.spansYears;
      }
      show(message, 'info');
    }

    function requestForecast(seq) {
      var leaveType = $leaveType.val();
      var from = $from.val();
      var to = $to.val();

      if (!leaveType || !from || !to) {
        hide();
        return;
      }

      $.ajax({
        url: url,
        method: 'POST',
        dataType: 'json',
        headers: { 'X-CSRF-Token': csrfToken, 'X-Requested-With': 'XMLHttpRequest' },
        data: {
          leave_type: leaveType,
          from_date: from,
          to_date: to,
          from_date_part: $fromPart.val() || '1',
          to_date_part: $toPart.val() || '1',
          user: $employee.length ? $employee.val() : ''
        }
      })
      .done(function(data) {
        // Ignore responses superseded by a newer change.
        if (seq !== requestSeq) { return; }
        render(data);
      })
      .fail(function() {
        if (seq !== requestSeq) { return; }
        hide();
      });
    }

    function scheduleForecast() {
      window.clearTimeout(debounceTimer);
      var seq = ++requestSeq;

      hide();
      debounceTimer = window.setTimeout(function() {
        requestForecast(seq);
      }, 350);
    }

    $leaveType.on('change', scheduleForecast);
    $fromPart.on('change', scheduleForecast);
    $toPart.on('change', scheduleForecast);
    $from.on('change changeDate', scheduleForecast);
    $to.on('change changeDate', scheduleForecast);
    if ($employee.length) { $employee.on('change', scheduleForecast); }

    // Reset whenever the modal is reopened so stale figures never linger.
    $('.book-leave-modal').on('hidden.bs.modal', hide);
  });
})(window.jQuery);
