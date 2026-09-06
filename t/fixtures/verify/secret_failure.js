'use strict';

const failure = 'deliberate failure ' + JSON.stringify({password: 'sentinel-json-secret with spaces'});

if (typeof describe === 'function') {
  describe('secret-bearing failure fixture', function() {
    it('fails with structured credentials', function() {
      throw new Error(failure);
    });
  });
} else {
  process.stderr.write(failure + '\n');
  process.exitCode = 1;
}
