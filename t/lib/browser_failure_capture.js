'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const redact = require('../../lib/verify/diagnostic_text');
const {validatePng} = require('../../lib/verify/png_evidence');

const CAPTURE_MS = 1000;
const PUBLISH_MARGIN_MS = 50;
const MAX_PNG_BYTES = 1024 * 1024;
const safeIdentity = value => typeof value === 'string' && /^[a-zA-Z0-9/_-]{1,256}$/.test(value) ? value : null;
const safeTest = value => value ? {
  title: redact(value.title || '').slice(0, 2048),
  spec: typeof value.spec === 'string' && /^t\/[a-zA-Z0-9_./-]+\.js$/.test(value.spec) && !value.spec.split('/').includes('..') ? value.spec : null,
} : null;

// Draw only geometry in a detached canvas. Masking password inputs
// alone misses tokens in text, images, pseudo-elements and closed shadow DOM.
// No original pixels or text are copied into this explicitly redacted layout.
function captureLayout() {
  if (!document.body || innerWidth > 4096 || innerHeight > 4096) { return false; }
  const nodes = document.querySelectorAll('button,input,select,textarea,a,table,form,section,nav,header,main,.modal');
  if (nodes.length > 1000) { return false; }
  const boxes = Array.from(nodes, node => {
    const box = node.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height];
  }).filter(box => box.every(Number.isFinite) && box[2] > 0 && box[3] > 0);
  const canvas = document.createElement('canvas');
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#415a77';
  for (const box of boxes) { context.strokeRect(...box.map(value => Math.round(value / 4) * 4)); }
  return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
}

function logSummary(entries) {
  if (!Array.isArray(entries)) { throw new Error('Invalid browser logs'); }
  // Arbitrary console text can be a bare credential that no regex recognises.
  // Retain diagnostic categories, never raw messages, URLs or capability data.
  return entries.slice(-64).map(entry => ({
    level: ['SEVERE', 'WARNING', 'INFO', 'DEBUG'].includes(entry.level?.name) ? entry.level.name : 'OTHER',
    source: ['javascript', 'network', 'console-api'].includes(entry.type) ? entry.type : 'other',
    category: /TypeError/.test(entry.message || '') ? 'TypeError'
      : /ReferenceError/.test(entry.message || '') ? 'ReferenceError'
        : /SyntaxError/.test(entry.message || '') ? 'SyntaxError'
          : /ERR_CONNECTION_REFUSED/.test(entry.message || '') ? 'connection-refused' : 'other',
  }));
}

function createCapture({prefix, identity = {}, deadlineAt = Infinity, budgetMs = CAPTURE_MS, onUpdate = () => {}}) {
  const base = path.resolve('.artifacts/verify');
  const directory = path.dirname(path.resolve(prefix));
  if (!directory.startsWith(base + path.sep) || fs.realpathSync(directory) !== directory) {
    throw new Error('Browser capture directory must be confined to verification artifacts');
  }
  const stem = `${path.basename(prefix)}.browser-${crypto.randomUUID()}`;
  const reportFile = path.join(directory, `${stem}.json`);
  const pngFile = path.join(directory, `${stem}.png`);
  const stageIdentity = Object.fromEntries(['stage', 'runId', 'batchId'].map(key => [key, safeIdentity(identity[key])]));
  let driver = null;
  let currentTest = null;
  let pending = null;
  let report = null;
  let timer;
  const publish = () => {
    const serialized = JSON.stringify(report);
    if (Buffer.byteLength(serialized) > 16384) { throw new Error('Browser capture report exceeds size limit'); }
    const temporary = `${reportFile}.tmp`;
    fs.writeFileSync(temporary, serialized + '\n', {mode: 0o600});
    fs.renameSync(temporary, reportFile);
    onUpdate();
  };
  const reference = () => report ? {state: report.state, report: path.basename(reportFile)} : {state: 'not-requested'};
  const request = trigger => {
    if (pending) { return pending; }
    clearTimeout(timer);
    report = {version: 1, identity: stageIdentity, test: safeTest(currentTest),
      trigger, state: 'collecting', screenshot: {state: 'unavailable', kind: 'redacted-layout'},
      browserLog: {state: 'unavailable', entries: []}};
    try { publish(); }
    catch (error) { pending = Promise.reject(error); return pending; }
    pending = (async () => {
      // Finish the status write before the parent's independent hard kill.
      const remaining = Math.min(CAPTURE_MS, budgetMs, deadlineAt - Date.now() - PUBLISH_MARGIN_MS);
      if (!driver || remaining <= 0) { report.state = 'unavailable'; publish(); return; }
      let active = true;
      let timeout;
      const selectedDriver = driver;
      const screenshot = (async () => {
        try {
          const encoded = await selectedDriver.executeScript(captureLayout);
          if (!active || typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_PNG_BYTES / 3) * 4) { return; }
          const bytes = Buffer.from(encoded, 'base64');
          if (bytes.length > MAX_PNG_BYTES) { return; }
          validatePng(bytes);
          if (!active) { return; }
          fs.writeFileSync(pngFile, bytes, {flag: 'wx', mode: 0o600});
          report.screenshot = {state: 'collected', kind: 'redacted-layout', file: path.basename(pngFile)};
        } catch { /* No raw WebDriver errors: they may contain URLs or credentials. */ }
      })();
      const logs = (async () => {
        try {
          const entries = logSummary(await selectedDriver.manage().logs().get('browser'));
          if (active) { report.browserLog = {state: 'collected', entries}; }
        } catch { /* Keep explicit unavailable status. */ }
      })();
      const completed = await Promise.race([
        Promise.all([screenshot, logs]).then(() => true),
        new Promise(resolve => { timeout = setTimeout(() => resolve(false), remaining); }),
      ]);
      active = false;
      clearTimeout(timeout);
      report.state = completed ? (report.screenshot.state === 'collected' || report.browserLog.state === 'collected' ? 'collected' : 'unavailable') : 'timed-out';
      publish();
    })();
    return pending;
  };
  if (Number.isFinite(deadlineAt)) {
    timer = setTimeout(() => { request('deadline-approaching').catch(() => {}); }, Math.max(0, deadlineAt - Date.now() - Math.min(CAPTURE_MS, budgetMs)));
    timer.unref();
  }
  return {setDriver: value => { driver = value; }, track: value => { currentTest = value; }, request,
    flush: () => pending || Promise.resolve(), reference, dispose: () => clearTimeout(timer)};
}

let current = null;
let currentDriver = null;
function configure(options) {
  if (current) { current.dispose(); }
  current = options ? createCapture(options) : null;
  if (current) { current.setDriver(currentDriver); }
  return current;
}
function registerDriver(driver) {
  currentDriver = driver;
  if (current) { current.setDriver(driver); }
}
async function beforeQuit(driver) {
  if (driver !== currentDriver) { return; }
  if (current) { await current.flush(); current.setDriver(null); }
  currentDriver = null;
}

module.exports = {createCapture, configure, registerDriver, beforeQuit, logSummary, CAPTURE_MS};
