'use strict';

/*
  The browser suite went silent on CI for up to twenty-four minutes at a time,
  with no test running and nothing left to print, until something outside killed
  it. Both captured hangs begin on the line immediately after mocha reported a
  failing test — which is where the after hook runs.

  Every integration spec tears down the same way:

      after(function(done){ driver.quit().then(function(){ done(); }); });

  No catch, no ceiling. A quit that rejects never calls done(). A quit that sits
  on a socket to a browser that has already gone never calls it either. Either
  way the suite can neither continue nor end.

  Teardown has no assertion to make, so the wrapper resolves whatever happens.
  These cover the two cases a real browser will not reproduce on demand.
*/

const expect = require('chai').expect;
const {boundQuit} = require('../lib/build_driver');

describe('Driver teardown', function() {

  it('resolves when quit succeeds', async function() {
    let called = false;
    const quit = boundQuit(async () => { called = true; }, 5000);

    await quit();

    expect(called).to.equal(true);
  });

  it('resolves when quit rejects, rather than leaving done() uncalled', async function() {
    const quit = boundQuit(async () => { throw new Error('session deleted'); }, 5000);

    // Would reject, and so hang the hook, without the wrapper.
    await quit();
  });

  it('resolves when quit throws synchronously', async function() {
    const quit = boundQuit(() => { throw new Error('no session'); }, 5000);

    await quit();
  });

  /*
    The case that produced the silence: the request goes out and nothing ever
    comes back. Without a ceiling this waits forever.
  */
  it('gives up on a quit that never returns', async function() {
    const started = Date.now();
    const quit = boundQuit(() => new Promise(() => {}), 120);

    await quit();

    const waited = Date.now() - started;

    expect(waited).to.be.at.least(100);
    expect(waited, 'waited far longer than the ceiling').to.be.below(3000);
  });

  /*
    A quit that answers only after the ceiling has already fired must not report
    twice: every run would then carry a stray line for a teardown that worked.
  */
  it('reports once when a late quit answers after the ceiling', async function() {
    const notes = [];
    const realError = console.error;
    let resolveLate;
    const late = new Promise(resolve => { resolveLate = resolve; });

    console.error = message => notes.push(message);

    try {
      await boundQuit(() => late, 60)();
      resolveLate();
      await late;
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      console.error = realError;
    }

    expect(notes).to.have.length(1);
    expect(notes[0]).to.match(/did not return within/);
  });

  it('does not hold the process open with its own timer', function() {
    // The ceiling is unref'd: a teardown that finishes early must not leave a
    // pending timer keeping node alive, which is the very failure being fixed.
    const timers = process._getActiveHandles()
      .filter(handle => handle && handle.constructor && handle.constructor.name === 'Timeout')
      .filter(handle => handle.hasRef && handle.hasRef());
    const before = timers.length;

    boundQuit(() => new Promise(() => {}), 60000)();

    const after = process._getActiveHandles()
      .filter(handle => handle && handle.constructor && handle.constructor.name === 'Timeout')
      .filter(handle => handle.hasRef && handle.hasRef());

    expect(after.length).to.equal(before, 'the teardown ceiling is holding a referenced timer');
  });
});
