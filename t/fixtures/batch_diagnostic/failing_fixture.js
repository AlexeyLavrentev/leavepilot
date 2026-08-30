'use strict';

describe('batch diagnostic fixture', function() {
  it('records a deliberate red failure', function() {
    throw new Error('x'.repeat(5000) + ' authorization=Bearer private-fixture-token failure');
  });
});
