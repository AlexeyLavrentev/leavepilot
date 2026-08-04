'use strict';

/*
 * Stage 8M — Reminder Schedules Workspace contract.
 *
 * The page redesign must preserve the existing feature gate, API endpoints,
 * CSRF transport, payload fields, validation and Engram/RESP2 deployment
 * boundary while making the rendered workflow responsive and accessible.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

function blockOf(source, selector) {
  const start = source.indexOf(selector);
  expect(start, 'expected selector ' + selector).to.be.greaterThan(-1);
  let depth = 0;
  let index = source.indexOf('{', start);
  const begin = index;
  for (; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(begin, index + 1);
}

describe('Reminder Schedules workspace contract (Stage 8M)', function () {
  const view = read('views/reminder_schedules_settings.hbs');
  const route = read('lib/route/reminder_schedules.js');
  const community = read('lib/edition/community.js');
  const features = read('lib/features.js');
  const scss = read('scss/main.scss');
  const css = read('public/css/style.css');
  const compose = read('docker-compose.yml');
  const redisConfig = read('config/app.redis.json');

  describe('page shell and workspace hierarchy', function () {
    it('uses one scoped main, the established heading, and two surfaces', function () {
      expect(view).to.include('<main id="main-content" class="reminder-schedules-page" tabindex="-1">');
      expect(view.match(/<h1[\s>]/g) || []).to.have.lengthOf(1);
      expect(view).to.include('class="page-heading"');
      expect(view.match(/<section class="surface/g) || []).to.have.lengthOf(2);
      expect(view).to.include('reminder-schedules-catalog');
      expect(view).to.include('reminder-schedules-test');
    });

    it('removes legacy panels without removing the Bootstrap modal', function () {
      expect(view).to.not.match(/\bpanel(?:-default|-heading|-body)?\b/);
      expect(view).to.include('class="modal fade reminder-schedule-modal"');
      expect(view).to.include('role="dialog" aria-labelledby="schedule-modal-title"');
    });

    it('keeps both add entry points mapped to the same manual form opener', function () {
      expect(view).to.include('id="add-schedule"');
      expect(view).to.include('id="add-first-schedule"');
      expect(view).to.include("document.getElementById('add-schedule').addEventListener('click', function() { openForm(null); })");
      expect(view).to.include("document.getElementById('add-first-schedule').addEventListener('click', function() { openForm(null); })");
    });
  });

  describe('schedule catalog and modal DOM contract', function () {
    it('uses the established semantic mobile-card table pattern', function () {
      expect(view).to.include('mobile-card-table-container reminder-schedules-table-container');
      expect(view).to.include('table table-hover mobile-card-table reminder-schedules-table');
      expect(view).to.include('role="region"');
      expect(view).to.include('tabindex="0"');
      expect(view).to.include('<caption class="sr-only">');
      expect(view.match(/<th scope="col">/g) || []).to.have.lengthOf(5);
    });

    it('creates localized labels, status text, and deliberate row hooks', function () {
      expect(view).to.include("row.setAttribute('data-reminder-schedule-row', String(schedule.id))");
      expect(view).to.include("cell.setAttribute('data-label', label)");
      expect(view).to.include("'mobile-card-action reminder-schedule-actions'");
      expect(view).to.include("'reminder-status-chip '");
      expect(view).to.include('schedule.isActive ? \'{{t "emails.reminderSchedules.active"}}\' : \'{{t "emails.reminderSchedules.inactive"}}\'');
    });

    it('preserves every schedule form identifier and native constraint', function () {
      for (const id of [
        'schedule-form',
        'schedule-id',
        'schedule-leave-type',
        'schedule-days',
        'recipient-employee',
        'recipient-supervisor',
        'schedule-active',
        'schedule-subject',
        'schedule-body',
      ]) {
        expect(view).to.include('id="' + id + '"');
      }
      expect(view).to.match(/id="schedule-days"[^>]*type="number"[^>]*min="1"[^>]*max="365"[^>]*required/);
      expect(view).to.match(/id="schedule-subject"[^>]*maxlength="500"/);
    });

    it('preserves the test-send form identifiers and constraints', function () {
      expect(view).to.include('id="test-send-form"');
      expect(view).to.match(/id="test-leave" required/);
      expect(view).to.match(/id="test-days" type="number" min="1" max="365" value="7" required/);
    });

    it('keeps destructive deletion behind the existing localized confirmation', function () {
      expect(view).to.include("if (!window.confirm('{{t \"emails.reminderSchedules.deleteConfirm\"}}')) return");
      expect(view).to.include("method: 'DELETE'");
    });
  });

  describe('protected request and security contract', function () {
    it('keeps the CSRF token and same-origin JSON request headers', function () {
      expect(view).to.include('var csrf = {{{json csrfToken}}};');
      expect(view).to.include("'X-CSRF-Token': csrf, 'Content-Type': 'application/json'");
      expect(route).to.include('csrfToken: res.locals.csrf_token');
    });

    it('keeps every API endpoint and method in the inline controller', function () {
      expect(view).to.include("request('/api/reminder-schedules')");
      expect(view).to.include("'/api/reminder-schedules/' + id");
      expect(view).to.include("method: id ? 'PUT' : 'POST'");
      expect(view).to.include("request('/api/reminder-schedules/' + schedule.id, {method: 'DELETE'})");
      expect(view).to.include("request('/api/reminder-schedules/test-send', {method: 'POST'");
    });

    it('keeps every persisted JSON payload field', function () {
      for (const field of [
        'leaveTypeId',
        'daysBefore',
        'recipientEmployee',
        'recipientSupervisor',
        'isActive',
        'emailSubjectCustom',
        'emailBodyCustom',
      ]) {
        expect(view).to.match(new RegExp('\\b' + field + ':'));
      }
    });

    it('keeps settings and API routes behind the community feature and admin boundary', function () {
      expect(community.match(/feature\s*:\s*'leave_start_reminders'/g) || []).to.have.lengthOf(3);
      expect(community).to.include('middleware: [features.requireFeature(feature), ensureAdmin]');
      expect(features).to.include('leave_start_reminders: { defaultEnabled: true }');
      for (const signature of [
        "app.get('/api/reminder-schedules'",
        "app.post('/api/reminder-schedules'",
        "app.put('/api/reminder-schedules/:id'",
        "app.delete('/api/reminder-schedules/:id'",
        "app.get('/api/reminder-schedules/history'",
        "app.post('/api/reminder-schedules/test-send'",
        "app.get('/settings/reminder-schedules/'",
      ]) {
        expect(route).to.include(signature);
      }
    });

    it('keeps server validation and company scoping unchanged', function () {
      expect(route).to.include('days >= 1 && days <= 365');
      expect(route).to.include('if (!sendSupervisor && !sendEmployee)');
      expect(route).to.include('where: {company_id: company.id}');
      expect(route).to.include('if (leave.user.companyId !== company.id)');
      expect(route).to.include("recipient: req.user");
    });

    it('does not touch the Engram RESP2 compatibility boundary', function () {
      expect(compose).to.include('redis:');
      expect(compose).to.include('image: ghcr.io/alexeylavrentev/engram:0.2');
      expect(compose).to.include('redis_data:/data');
      expect(redisConfig).to.match(/"host"\s*:\s*"redis"/);
    });
  });

  describe('accessible feedback and scoped presentation', function () {
    it('exposes atomic status feedback and promotes errors to alerts', function () {
      expect(view).to.include('aria-live="polite" aria-atomic="true"');
      expect(view).to.include("feedback.setAttribute('role', isError ? 'alert' : 'status')");
      expect(view).to.include("feedback.setAttribute('aria-live', isError ? 'assertive' : 'polite')");
    });

    it('declares light and dark tokens only under the page scope', function () {
      expect(blockOf(scss, '.reminder-schedules-page')).to.include('--reminder-surface:');
      expect(blockOf(scss, '[data-theme="dark"] .reminder-schedules-page')).to.include('--reminder-active-bg:');
      expect(scss).to.not.match(/:root\s*\{[^}]*--reminder-/);
    });

    it('compiles the surfaces, test grid, modal, and status chips', function () {
      expect(css).to.include('/* Stage 8M: Reminder Schedules Workspace */');
      expect(css).to.match(/\.reminder-schedules-page \.surface\s*\{/);
      expect(css).to.match(/\.reminder-schedules-page \.reminder-test-form\s*\{[^}]*grid-template-columns:/);
      expect(css).to.match(/\.reminder-schedules-page \.reminder-schedule-modal \.modal-dialog\s*\{[^}]*max-width:\s*720px/);
      expect(css).to.match(/\.reminder-schedules-page \.reminder-status-active\s*\{/);
      expect(css).to.match(/\.reminder-schedules-page \.reminder-status-inactive\s*\{/);
    });

    it('provides 44px controls and 48px option labels', function () {
      expect(css).to.match(/\.reminder-schedules-page \.form-control\s*\{[^}]*min-height:\s*44px/);
      expect(css).to.match(/\.reminder-schedules-page \.reminder-schedule-option,[\s\S]*min-height:\s*48px/);
      expect(css).to.match(/\.reminder-schedules-page \.reminder-schedule-modal \.modal-footer \.btn\s*\{[^}]*min-height:\s*44px/);
    });

    it('overrides global mobile card chrome and collapses every field grid', function () {
      const stage = css.slice(css.indexOf('/* Stage 8M: Reminder Schedules Workspace */'));
      expect(stage).to.match(/@media \(max-width: 768px\)[\s\S]*\.reminder-schedules-page \.reminder-schedules-table > tbody > tr[\s\S]*background:\s*var\(--reminder-surface\)/);
      expect(stage).to.match(/\.reminder-schedules-page \.reminder-schedules-table > tbody > tr > td\s*\{[^}]*white-space:\s*normal/);
      expect(stage).to.match(/\.reminder-schedules-page \.reminder-test-form,[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
      expect(stage).to.include('overflow: visible');
    });

    it('uses press feedback and neutralizes its compound under reduced motion', function () {
      expect(css).to.match(/\.reminder-schedules-page[^{}]*:active[^{}]*,[^{}]*\.reminder-schedules-page[^{}]*:hover:active[^{}]*\{[^}]*transform:\s*scale\(0\.98\)/);
      const stage = css.slice(css.indexOf('/* Stage 8M: Reminder Schedules Workspace */'));
      const reduced = stage.slice(stage.indexOf('@media (prefers-reduced-motion: reduce)'));
      expect(reduced).to.include('.reminder-schedules-page .btn:hover:active');
      expect(reduced).to.match(/transform:\s*none/);
    });

    it('supports contrast and reduced transparency without unscoped overrides', function () {
      const stage = css.slice(css.indexOf('/* Stage 8M: Reminder Schedules Workspace */'));
      expect(stage).to.include('@media (prefers-contrast: more)');
      expect(stage).to.not.match(/\n\.(?:btn|row|form-group|surface|modal-content)\s*\{/);
    });

    it('uses px typography throughout the page scope', function () {
      const stage = css.slice(css.indexOf('/* Stage 8M: Reminder Schedules Workspace */'));
      const rules = stage.match(/\.reminder-schedules-page[^{}]*\{[^}]*\}/g) || [];
      expect(rules.length).to.be.greaterThan(30);
      for (const rule of rules) expect(rule).to.not.match(/font-size:\s*[\d.]+rem/);
    });
  });
});
