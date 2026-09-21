'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {expect} = require('chai');
const {createCapture, logSummary} = require('../lib/browser_failure_capture');
const {png} = require('../fixtures/verify/png');

describe('bounded browser failure capture', function() {
  let directory;
  let capture;
  beforeEach(() => { directory = fs.mkdtempSync(path.resolve('.artifacts/verify/capture-test-')); });
  afterEach(() => { if (capture) { capture.dispose(); } fs.rmSync(directory, {recursive: true, force: true}); });
  const read = () => JSON.parse(fs.readFileSync(path.join(directory, capture.reference().report), 'utf8'));
  const make = options => createCapture({prefix: path.join(directory, 'batch'), identity: {stage: 'run/browser-1', runId: '1-2', batchId: 'batch-1'}, ...options});
  const driver = () => ({
    executeScript: async () => png().toString('base64'),
    manage: () => ({logs: () => ({get: async () => [{level: {name: 'SEVERE'}, type: 'console-api', message: 'TypeError capture-private-value password=another-private-value'}]})}),
  });

  it('stores validated layout PNG and categorized logs without message or page secrets', async () => {
    capture = make(); capture.setDriver(driver());
    capture.track({title: 'failure password=capture-private-value', spec: 't/fixtures/verify/browser_capture.js'});
    await capture.request('failure');
    const report = read();
    expect(report.state).to.equal('collected');
    expect(report.identity.stage).to.equal('run/browser-1');
    expect(report.screenshot.kind).to.equal('redacted-layout');
    expect(fs.readFileSync(path.join(directory, report.screenshot.file))).to.deep.equal(png());
    expect(report.browserLog.entries).to.deep.equal([{level: 'SEVERE', source: 'console-api', category: 'TypeError'}]);
    expect(JSON.stringify(report)).not.to.include('capture-private-value');
    expect(JSON.stringify(report)).not.to.include('another-private-value');
    await capture.request('retry');
    expect(read()).to.deep.equal(report);
  });

  it('bounds hung capture and prevents late screenshot writes or report mutation', async () => {
    let complete;
    const fake = driver();
    fake.executeScript = () => new Promise(resolve => { complete = resolve; });
    capture = make({budgetMs: 25}); capture.setDriver(fake);
    await capture.request('failure');
    const report = read();
    expect(report.state).to.equal('timed-out');
    complete(png().toString('base64'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(read()).to.deep.equal(report);
    expect(fs.readdirSync(directory).filter(file => file.endsWith('.png'))).to.deep.equal([]);
  });

  it('records no driver and expired deadline explicitly', async () => {
    capture = make({deadlineAt: Date.now() - 1}); capture.setDriver(driver());
    await capture.request('failure');
    expect(read().state).to.equal('unavailable');
  });

  it('starts capture before the supplied deadline without extending it', async () => {
    let updated;
    const done = new Promise(resolve => { updated = resolve; });
    capture = make({deadlineAt: Date.now() + 60, budgetMs: 20, onUpdate: () => {
      if (capture.reference().state !== 'collecting') { updated(); }
    }});
    await done;
    expect(read()).to.include({trigger: 'deadline-approaching', state: 'unavailable'});
  });

  it('rejects invalid PNG while retaining safe log diagnostics', async () => {
    const fake = driver(); fake.executeScript = async () => Buffer.from('private-pixels').toString('base64');
    capture = make(); capture.setDriver(fake); await capture.request('failure');
    expect(read().screenshot.state).to.equal('unavailable');
    expect(fs.readdirSync(directory).filter(file => file.endsWith('.png'))).to.deep.equal([]);
  });

  it('renders only rounded geometry into a detached canvas, never raw browser pixels', async () => {
    const boxes = [];
    const context = {fillRect() {}, strokeRect: (...box) => boxes.push(box)};
    const canvas = {getContext: () => context, toDataURL: () => `data:image/png;base64,${png().toString('base64')}`};
    const fake = driver();
    fake.executeScript = async script => vm.runInNewContext(`(${script.toString()})()`, {
      innerWidth: 800, innerHeight: 600,
      document: {
        body: {},
        querySelectorAll: () => [{getBoundingClientRect: () => ({x: 9, y: 9, width: 99, height: 31})}],
        createElement: tag => { expect(tag).to.equal('canvas'); return canvas; },
      },
    });
    capture = make(); capture.setDriver(fake); await capture.request('failure');
    expect(read().screenshot.state).to.equal('collected');
    expect(boxes).to.deep.equal([[8, 8, 100, 32]]);
    expect(canvas).to.include({width: 800, height: 600});
  });

  it('records unavailable WebDriver operations without leaking their errors', async () => {
    const fake = driver();
    fake.executeScript = async () => { throw new Error('private-driver-value'); };
    fake.manage = () => { throw new Error('private-log-value'); };
    capture = make(); capture.setDriver(fake); await capture.request('failure');
    expect(read().state).to.equal('unavailable');
    expect(JSON.stringify(read())).not.to.include('private-');
  });

  it('rejects oversized encoded images before decoding or writing them', async () => {
    const fake = driver(); fake.executeScript = async () => 'A'.repeat(1400000);
    capture = make(); capture.setDriver(fake); await capture.request('failure');
    expect(read().screenshot.state).to.equal('unavailable');
    expect(fs.readdirSync(directory).filter(file => file.endsWith('.png'))).to.deep.equal([]);
  });

  it('returns artifact write failures as a promise without throwing from the runner event', async () => {
    capture = make({prefix: path.join(directory, 'x'.repeat(250))});
    const result = capture.request('failure');
    expect(result).to.be.instanceOf(Promise);
    const error = await result.catch(value => value);
    expect(error.code).to.equal('ENAMETOOLONG');
  });

  it('rejects paths outside the artifact tree and symlinked parents', () => {
    expect(() => createCapture({prefix: '/tmp/unrelated-browser'})).to.throw('confined');
    fs.symlinkSync(directory, path.join(directory, 'linked'));
    expect(() => createCapture({prefix: path.join(directory, 'linked', 'file')})).to.throw('confined');
    expect(logSummary([{level: {name: 'private-value'}, message: 'bare-private-value'}]))
      .to.deep.equal([{level: 'OTHER', source: 'other', category: 'other'}]);
  });
});
