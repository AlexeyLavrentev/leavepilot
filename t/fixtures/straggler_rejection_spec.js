'use strict';

/*
  The other fixture for t/unit/fail_fast.js, and the one that keeps the net
  honest.

  A WebDriver command belonging to a chain the suite has moved on from can
  reject long after anybody cares - a StaleElementReference once the page has
  navigated. Nothing handles it, and nothing should: submit_form's withDeadline
  drops those on purpose. The first full run of the suite with an
  exit-on-first-rejection net went red on exactly one of these, in
  t/integration/department/one_by_one_crud.js.

  So this fixture loses a rejection and then finishes anyway. It has to pass.
*/

describe('A spec that leaves a straggler behind', function() {

  it('finishes despite an abandoned chain rejecting', function(done) {
    // Nobody is waiting on this one, and it rejects after the test has moved on.
    setTimeout(function() {
      Promise.reject(new Error('stale element reference: stale element not found'));
    }, 5);

    setTimeout(done, 40);
  });

  it('and the run carries on to the next test', function() {
    // Reaching here at all is the assertion: a boundary was crossed, which is
    // what stands the alarm down.
  });
});
