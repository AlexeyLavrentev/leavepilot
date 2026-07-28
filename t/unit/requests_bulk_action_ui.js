'use strict';

const fs = require('fs');
const path = require('path');
const expect = require('chai').expect;

const root = path.join(__dirname, '../..');
const viewSource = fs.readFileSync(path.join(root, 'views/requests.hbs'), 'utf8');
const scriptSource = fs.readFileSync(path.join(root, 'public/js/global.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'scss/main.scss'), 'utf8');
const locales = ['en', 'ru', 'uk', 'be', 'kk'].map(function(locale) {
  return JSON.parse(fs.readFileSync(
    path.join(root, 'public/locales', locale, 'translation.json'),
    'utf8'
  ));
});

describe('Requests decision-safety UI', function() {

  it('uses semantic headings without duplicating the existing table region', function() {
    expect(viewSource).to.contain(
      '<h2 id="requests-to-approve-heading" class="main-row_header requests-section-heading">'
    );
    expect(viewSource).to.contain(
      '<h2 id="requests-all-absences-heading" class="main-row_header requests-section-heading">'
    );
    expect(viewSource).to.not.contain('<section class="row"');
    expect(viewSource).to.not.contain(
      'aria-labelledby="requests-to-approve-heading"'
    );
    expect(viewSource).to.not.match(/main-row_header">\s*<p/);
  });

  it('gives each selection and row action employee/date context', function() {
    expect(viewSource).to.match(
      /bulk-request-checkbox[\s\S]*?aria-label="\{\{t "requests\.selectRow"\}\}: \{\{full_name this\.user\}\}, \{\{as_date this\.date_start\}\} — \{\{as_date this\.date_end\}\}"/
    );
    expect(viewSource).to.match(
      /value="\{\{t "requests\.reject"\}\}" aria-label="\{\{t "requests\.reject"\}\}: \{\{full_name this\.user\}\}, \{\{as_date this\.date_start\}\} — \{\{as_date this\.date_end\}\}"/
    );
    expect(viewSource).to.match(
      /value="\{\{t "requests\.approve"\}\}" aria-label="\{\{t "requests\.approve"\}\}: \{\{full_name this\.user\}\}, \{\{as_date this\.date_start\}\} — \{\{as_date this\.date_end\}\}"/
    );
  });

  it('starts the contextual action form hidden and exposes localized state templates', function() {
    expect(viewSource).to.match(
      /id="bulk-action-form"[\s\S]*?data-count-template="\{\{t "requests\.selectedCount"\}\}"[\s\S]*?data-processing-template="\{\{t "requests\.processingSelected"\}\}"[\s\S]*?hidden/
    );
    expect(viewSource).to.contain('class="btn btn-link bulk-clear-btn"');
    expect(viewSource).to.contain('class="sr-only bulk-action-status" role="status"');
    expect(viewSource).to.not.contain('<script>');
  });

  it('keeps selection, panel visibility and row feedback in one page-scoped controller', function() {
    expect(scriptSource).to.contain("var $form = $('#bulk-action-form');");
    expect(scriptSource).to.contain("toggleClass('is-selected', this.checked)");
    expect(scriptSource).to.contain("$form.prop('hidden', !hasSelection)");
    expect(scriptSource).to.contain("toggleClass('has-active-bulk-actions', hasSelection)");
    expect(scriptSource).to.contain("$selectAll.prop('indeterminate'");
    expect(scriptSource).to.contain('function keepRowAboveActions(checkbox)');
    expect(scriptSource).to.contain('window.scrollBy(0, overlap)');
    expect(scriptSource).to.contain(
      "lastChangedCheckbox = $checkboxes.filter(':checked').last()[0] || null"
    );
    expect(scriptSource).to.contain(
      "$(window).on('pageshow.requestsBulkActions', restoreSelectionAfterPageShow)"
    );
    expect(scriptSource).to.contain('window.setTimeout(restoreInitialSelection, 0)');
    expect(scriptSource).to.contain(
      "'hidden.bs.collapse.requestsBulkActions shown.bs.collapse.requestsBulkActions'"
    );
    expect(scriptSource).to.contain('keepRowAboveActions(lastChangedCheckbox)');
    expect(scriptSource).to.contain('$(lastChangedCheckbox).focus()');
  });

  it('sets the selected endpoint before entering guarded submitting state', function() {
    const actionIndex = scriptSource.indexOf("$form.attr('action', action)");
    const submittingIndex = scriptSource.indexOf("submitting = true", actionIndex);

    expect(actionIndex).to.be.greaterThan(-1);
    expect(submittingIndex).to.be.greaterThan(actionIndex);
    expect(scriptSource).to.contain('if (submitting || count === 0)');
    expect(scriptSource).to.contain("$form.attr('aria-busy', 'true')");
    expect(scriptSource).to.contain("$status.text(processingTemplate.replace('{count}', count))");
    expect(scriptSource).to.not.contain("$checkboxes.prop('disabled', true)");
  });

  it('moves focus to Requests feedback after a redirect result', function() {
    expect(viewSource).to.contain('id="requests-feedback" data-focus-alert-on-load');
    expect(scriptSource).to.contain(
      "$('#requests-feedback[data-focus-alert-on-load] [role=\"alert\"]').first()"
    );
    expect(scriptSource).to.contain("$feedback.attr('tabindex', '-1').focus()");
  });

  it('defines a 44px selection target and fixed contextual surface', function() {
    expect(styleSource).to.match(
      /\.bulk-request-selector\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/
    );
    expect(styleSource).to.match(
      /\.bulk-action-bar\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?bottom:\s*\$space-4;/
    );
    expect(styleSource).to.contain('.requests-page.has-active-bulk-actions');
    expect(styleSource).to.contain(
      '.requests-to-approve-table > tbody > tr.is-selected > td'
    );
    expect(styleSource).to.match(
      /\.bulk-clear-btn\s*\{[\s\S]*?color:\s*var\(--color-link\);/
    );
    expect(styleSource).to.match(
      /\.main-row_header[\s\S]*?color:\s*var\(--color-heading\);/
    );
  });

  it('provides clear and processing feedback in every supported locale', function() {
    locales.forEach(function(locale) {
      expect(locale.requests.clearSelection).to.be.a('string').and.not.empty;
      expect(locale.requests.processingSelected).to.be.a('string').and.include('{count}');
    });
  });
});
