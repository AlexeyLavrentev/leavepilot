'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const load = ({platform = 'darwin', code = 'EPERM', rows = '123 501 Z\n', snapshotError} = {}) => {
  const snapshots = [];
  const source = fs.readFileSync(path.join(__dirname, '../../bin/lib/spawn_group.js'), 'utf8');
  const context = {
    module: {exports: {}},
    process: {platform, getuid: () => 501, kill() { throw Object.assign(new Error(code), {code}); }},
    require(name) {
      if (name !== 'child_process') { return require(name); }
      return {execFileSync(command, args, options) {
        snapshots.push({command, args, options});
        if (snapshotError) { throw snapshotError; }
        return rows;
      }};
    },
  };
  vm.runInNewContext(source, context);
  return {kill: () => context.module.exports.killGroup({pid: 123}, 'SIGKILL'), snapshots};
};

describe('Darwin process-group cleanup', function() {
  for (const rows of ['123 501 Z\n', '123 501 ?E\n', '123 501 Zs\n123 501 ?Es\n', '456 501 R\n', '456 -2 S\n123 501 Z\n']) {
    it(`recognizes only terminal or absent owned members: ${rows.trim().replace(/\n/g, ', ')}`, function() {
      const probe = load({rows});
      assert.strictEqual(probe.kill(), false);
      assert.strictEqual(probe.snapshots.length, 1);
      const snapshot = probe.snapshots[0];
      assert.strictEqual(snapshot.command, '/bin/ps');
      assert.deepStrictEqual(Array.from(snapshot.args), ['-A', '-o', 'pgid=,uid=,stat=']);
      assert.strictEqual(snapshot.options.timeout, 1000);
      assert.strictEqual(snapshot.options.maxBuffer, 1024 * 1024);
    });
  }

  for (const rows of ['123 501 S\n', '123 501 Z\n123 501 R\n', '123 0 Z\n', '123 -2 Z\n', '123 501 ?\n', '123 501 FAKE\n', '', 'malformed\n', '123 501 Z extra\n']) {
    it(`keeps uncertain/live/foreign groups red: ${JSON.stringify(rows)}`, function() {
      assert.throws(load({rows}).kill, {code: 'EPERM'});
    });
  }

  it('preserves permission errors when process inspection fails', function() {
    assert.throws(load({snapshotError: new Error('ps unavailable')}).kill, {code: 'EPERM'});
  });

  it('does not change other platforms or other signal errors', function() {
    for (const options of [{platform: 'linux'}, {code: 'EACCES'}, {code: 'ESRCH'}]) {
      const probe = load(options);
      if (options.code === 'ESRCH') { assert.strictEqual(probe.kill(), false); }
      else { assert.throws(probe.kill, {code: options.code || 'EPERM'}); }
      assert.strictEqual(probe.snapshots.length, 0);
    }
  });
});
