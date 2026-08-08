'use strict';

/*
  What a lost rejection costs, measured rather than argued from the source.

  The browser specs build promise chains and end them with done. Where the
  terminal .catch(done) is attached to an inner chain and the outer one has
  none, a rejection reaches nobody: done is never called, the test does not
  fail, and it sits until mocha's budget runs out and reports

    Timeout of 120000ms exceeded. For async tests and hooks, ensure "done()"
    is called; if returning a Promise, ensure it resolves.

  with no indication of the cause. bin/test.js then retries the whole batch and,
  where the process never exits, kills it after 300s and retries again - ten
  minutes spent on one error nobody ever sees.

  Both CI hangs looked like that, down to the last line printed: submit_form's
  fallback reading the flash messages one final time before throwing "Timed out
  waiting for flash message".

  The care is in not over-firing. A command from a chain the suite has moved on
  from rejects with nobody listening all the time, and that is fine - the first
  full run with an exit-on-first-rejection net went red on a
  StaleElementReference in one_by_one_crud.js, which is a worse outcome than the
  hang. So the rule is "a rejection nobody handled, after which the test never
  finished", and both halves of that are exercised here.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const mocha = path.join('node_modules', 'mocha', 'bin', 'mocha');
const net = path.join('t', 'lib', 'fail_fast.js');

const fixture = name => path.join('t', 'fixtures', name);

const runFixture = (name, options) => {
  const settings = options || {};

  return spawnSync(
    process.execPath,
    [mocha, '--exit', '--timeout', String(settings.timeout || 4000)]
      .concat(settings.withNet === false ? [] : ['--require', net])
      .concat([fixture(name)]),
    {
      cwd      : root,
      encoding : 'utf8',
      timeout  : 60000,
      // A short grace, so this suite does not sit through the real one.
      env      : Object.assign({}, process.env, {
        TEST_LOST_REJECTION_GRACE_MS : String(settings.grace || 400),
      }),
    }
  );
};

const outputOf = result => (result.stdout || '') + (result.stderr || '');

describe('A rejection nobody handled', function() {

  this.timeout(120000);

  describe('when the test never finishes', function() {

    let withoutNet;
    let withNet;

    before(function() {
      withoutNet = runFixture('lost_rejection_spec.js', {withNet: false});
      withNet = runFixture('lost_rejection_spec.js');
    });

    it('is otherwise reported as a timeout with no cause', function() {
      expect(outputOf(withoutNet)).to.match(/Timeout of 4000ms exceeded/);
    });

    it('otherwise says nothing about what actually went wrong', function() {
      expect(outputOf(withoutNet)).to.not.contain(
        'flash message never arrived',
        'the fixture no longer loses its rejection, so this comparison proves nothing'
      );
    });

    it('is reported with the error itself', function() {
      const output = outputOf(withNet);

      expect(output).to.contain('LOST REJECTION');
      expect(output).to.contain('flash message never arrived');
    });

    it('names the test that was running', function() {
      expect(outputOf(withNet))
        .to.contain('A spec that loses a rejection drops one on the floor and never finishes');
    });

    it('fails the run', function() {
      expect(withNet.status).to.not.equal(0);
    });

    /*
      The saving. Asserted against the fixture's own budget rather than a
      stopwatch, so it holds whatever the machine's speed.
    */
    it('says so without waiting out the budget', function() {
      expect(outputOf(withNet)).to.not.match(
        /Timeout of 4000ms exceeded/,
        'the rejection was reported but the test still burned its whole budget'
      );
    });
  });

  /*
    The half that keeps it usable. This is not a hypothetical: it is what the
    first full run found.
  */
  describe('when the test finishes anyway', function() {

    let result;

    before(function() {
      result = runFixture('straggler_rejection_spec.js');
    });

    it('lets the run pass', function() {
      expect(result.status).to.equal(
        0,
        'an abandoned chain rejecting is normal and must not fail anything:\n'
          + outputOf(result)
      );
    });

    it('says nothing about it', function() {
      expect(outputOf(result)).to.not.contain('LOST REJECTION');
    });

    it('and the tests after it still run', function() {
      expect(outputOf(result)).to.match(/2 passing/);
    });
  });

  describe('the runner asks for it', function() {

    const runner = fs.readFileSync(path.join(root, 'bin', 'test.js'), 'utf8');

    // Three places start mocha: an explicit path, an integration batch, and the
    // unit suite. A net on two of the three would be worse than none, because
    // it would read as covered.
    it('loads it in every mocha it starts', function() {
      const invocations = runner.match(/node_modules\/mocha\/bin\/mocha/g) || [];

      expect(invocations.length).to.be.above(2);
      expect((runner.match(/FAIL_FAST/g) || []).length).to.equal(invocations.length + 1);
    });

    it('points at a file that exists', function() {
      expect(runner).to.match(/const FAIL_FAST = \['--require'/);
      expect(fs.existsSync(path.join(root, net))).to.equal(true);
    });
  });
});
