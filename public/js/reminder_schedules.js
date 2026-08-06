/*
  The reminder schedules settings screen.

  Moved out of the page so that no page carries inline script. The CSRF token it
  needs used to be rendered straight into this code; it now comes from the
  page's configuration block, which the browser parses as data rather than
  executing.
*/
(function() {
  'use strict';
  // Was rendered into this script by the template. Now read from the page's
  // configuration block, which is data rather than code.
  var csrf = (window.timeoff || {}).csrfToken;

  /*
    Every label this screen builds in script used to be a translation
    rendered straight into it. They arrive as data now: the page carries them in
    a JSON block, which the browser parses rather than executes.
  */
  var configNode = document.getElementById('reminder-schedules-config');
  var pageConfig = {};

  try {
    pageConfig = configNode ? JSON.parse(configNode.textContent) : {};
  } catch (e) {
    pageConfig = {};
  }

  var strings = pageConfig.translations || {};
  var schedules = [];
  var tableBody = document.querySelector('#schedule-table tbody');
  var tableRegion = document.getElementById('schedule-table-region');
  var emptyState = document.getElementById('schedule-empty');
  var feedback = document.getElementById('schedule-feedback');

  function text(value) { return document.createTextNode(value == null ? '' : String(value)); }
  function showFeedback(message, isError) {
    feedback.className = 'alert reminder-schedules-feedback ' + (isError ? 'alert-danger' : 'alert-success');
    feedback.setAttribute('role', isError ? 'alert' : 'status');
    feedback.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    feedback.textContent = message;
  }
  async function request(url, options) {
    options = options || {};
    options.headers = Object.assign({'X-CSRF-Token': csrf, 'Content-Type': 'application/json'}, options.headers || {});
    var response = await fetch(url, options);
    var payload = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(payload.error || pageConfig.requestFailed);
    return payload;
  }
  function recipientLabel(schedule) {
    if (schedule.recipientEmployee && schedule.recipientSupervisor) return strings.recipientsBoth;
    return schedule.recipientEmployee
      ? strings.recipientsEmployee
      : strings.recipientsSupervisor;
  }
  function appendCell(row, value, label, className) {
    var cell = document.createElement('td');
    cell.setAttribute('data-label', label);
    if (className) cell.className = className;
    cell.appendChild(text(value));
    row.appendChild(cell);
    return cell;
  }
  function render() {
    tableBody.textContent = '';
    var isEmpty = schedules.length === 0;
    emptyState.classList.toggle('hidden', !isEmpty);
    tableRegion.classList.toggle('hidden', isEmpty);
    schedules.forEach(function(schedule) {
      var row = document.createElement('tr');
      row.setAttribute('data-reminder-schedule-row', String(schedule.id));
      if (!schedule.isActive) row.className = 'reminder-schedule-row-inactive';
      appendCell(row, 'T−' + schedule.daysBefore, strings.daysBefore, 'reminder-schedule-days');
      appendCell(row, schedule.leaveTypeName || strings.allTypes, strings.leaveType, 'reminder-schedule-leave-type');
      appendCell(row, recipientLabel(schedule), strings.recipients, 'reminder-schedule-recipients');

      var status = appendCell(row, '', strings.active, 'reminder-schedule-status');
      var statusChip = document.createElement('span');
      statusChip.className = 'reminder-status-chip ' + (schedule.isActive ? 'reminder-status-active' : 'reminder-status-inactive');
      statusChip.appendChild(text(schedule.isActive ? strings.active : strings.inactive));
      status.appendChild(statusChip);

      var actions = appendCell(row, '', strings.actions, 'mobile-card-action reminder-schedule-actions');
      var actionGroup = document.createElement('div');
      actionGroup.className = 'reminder-schedule-action-group';
      var edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'btn btn-link btn-xs reminder-schedule-edit'; edit.textContent = strings.editSchedule;
      edit.addEventListener('click', function() { openForm(schedule); });
      var remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn btn-link btn-xs text-danger reminder-schedule-delete'; remove.textContent = pageConfig.commonDelete;
      remove.addEventListener('click', function() { deleteSchedule(schedule); });
      actionGroup.appendChild(edit); actionGroup.appendChild(remove); actions.appendChild(actionGroup);
      tableBody.appendChild(row);
    });
  }
  async function load() {
    try { schedules = (await request('/api/reminder-schedules')).schedules; render(); }
    catch (error) { showFeedback(error.message, true); }
  }
  function openForm(schedule) {
    schedule = schedule || {};
    document.getElementById('schedule-id').value = schedule.id || '';
    document.getElementById('schedule-leave-type').value = schedule.leaveTypeId || '';
    document.getElementById('schedule-days').value = schedule.daysBefore || 7;
    document.getElementById('recipient-employee').checked = schedule.recipientEmployee !== false;
    document.getElementById('recipient-supervisor').checked = schedule.recipientSupervisor !== false;
    document.getElementById('schedule-active').checked = schedule.isActive !== false;
    document.getElementById('schedule-subject').value = schedule.emailSubjectCustom || '';
    document.getElementById('schedule-body').value = schedule.emailBodyCustom || '';
    document.getElementById('schedule-modal-title').textContent = schedule.id ? strings.editSchedule : strings.addSchedule;
    $('#schedule-modal').modal('show');
  }
  document.getElementById('add-schedule').addEventListener('click', function() { openForm(null); });
  document.getElementById('add-first-schedule').addEventListener('click', function() { openForm(null); });
  document.getElementById('schedule-form').addEventListener('submit', async function(event) {
    event.preventDefault();
    var id = document.getElementById('schedule-id').value;
    var payload = {
      leaveTypeId: document.getElementById('schedule-leave-type').value || null,
      daysBefore: Number(document.getElementById('schedule-days').value),
      recipientEmployee: document.getElementById('recipient-employee').checked,
      recipientSupervisor: document.getElementById('recipient-supervisor').checked,
      isActive: document.getElementById('schedule-active').checked,
      emailSubjectCustom: document.getElementById('schedule-subject').value.trim() || null,
      emailBodyCustom: document.getElementById('schedule-body').value.trim() || null
    };
    try {
      await request(id ? '/api/reminder-schedules/' + id : '/api/reminder-schedules', {method: id ? 'PUT' : 'POST', body: JSON.stringify(payload)});
      $('#schedule-modal').modal('hide'); await load(); showFeedback(strings.saved, false);
    } catch (error) { showFeedback(error.message, true); }
  });
  async function deleteSchedule(schedule) {
    if (!window.confirm(strings.deleteConfirm)) return;
    try { await request('/api/reminder-schedules/' + schedule.id, {method: 'DELETE'}); await load(); showFeedback(strings.deleted, false); }
    catch (error) { showFeedback(error.message, true); }
  }
  document.getElementById('test-send-form').addEventListener('submit', async function(event) {
    event.preventDefault();
    try {
      var result = await request('/api/reminder-schedules/test-send', {method: 'POST', body: JSON.stringify({leaveId: document.getElementById('test-leave').value, daysBefore: Number(document.getElementById('test-days').value)})});
      showFeedback(result.message, false);
    } catch (error) { showFeedback(error.message, true); }
  });
  load();
})();
