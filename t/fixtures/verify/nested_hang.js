'use strict';

const {spawn} = require('child_process');

describe('nested termination fixture', function() {
  it('keeps a detached TERM-resistant descendant alive', function(done) {
    this.timeout(0);
    const descendant = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); console.log('nested-ready=' + process.pid); setInterval(() => {}, 1000000);",
    ], {detached: true, stdio: ['ignore', 'inherit', 'inherit']});
    // Deliberately resist the runner's own cleanup to exercise outer ownership.
    process.on('SIGTERM', () => {});
    descendant.on('error', done);
  });
});
