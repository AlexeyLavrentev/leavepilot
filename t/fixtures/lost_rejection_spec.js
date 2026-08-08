'use strict';

/*
  Not a spec of this application - a fixture for t/unit/fail_fast.js, which runs
  it in a child mocha to see what a lost rejection looks like with and without
  the net.

  It lives outside t/unit and t/integration so neither the runner nor a
  recursive mocha invocation picks it up.

  The shape is the one the browser specs keep producing: the terminal
  .catch(done) is attached to an inner chain, so a rejection from the outer one
  reaches nobody and done is never called. The test cannot finish.
*/

describe('A spec that loses a rejection', function() {

  it('drops one on the floor and never finishes', function(done) {
    Promise.resolve()
      .then(function() {
        throw new Error('flash message never arrived');
      })
      .then(function() {
        // The catch belonged on the chain above, not in here.
        Promise.resolve().then(function() { done(); }).catch(done);
      });
  });
});
