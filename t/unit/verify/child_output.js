'use strict';

const {expect} = require('chai');
const createOutput = require('../../../lib/verify/child_output');

const capture = () => {
  const data = {stdout: '', stderr: ''};
  return {data, output: createOutput({
    stdout: text => {data.stdout += text;},
    stderr: text => {data.stderr += text;},
  })};
};

describe('bounded child output', function() {
  for (const [name, text] of [
    ['password assignment', 'password=split-sentinel\ncontinuation'],
    ['multiline password assignment', 'password\n =split-sentinel\ncontinuation'],
    ['Authorization header', 'Authorization: Bearer split-sentinel\ncontinuation'],
    ['multiline Bearer token', 'Bearer\nsplit-sentinel\ncontinuation'],
    ['database URL', 'mysql://user:split-sentinel@db/test\ncontinuation'],
    ['PEM header', '-----BEGIN PRIVATE KEY-----\nsplit-sentinel\ncontinuation'],
  ]) {
    it(`suppresses every byte split of ${name}`, function() {
      const bytes = Buffer.from(text);
      for (let i = 0; i <= bytes.length; i++) {
        const {data, output} = capture();
        output.write('stdout', Buffer.from('safe context\n'));
        output.write('stdout', bytes.subarray(0, i));
        output.write('stdout', bytes.subarray(i));
        output.write('stderr', Buffer.from('cross-pipe continuation'));
        output.end();
        expect(data.stdout + data.stderr).to.include('safe context');
        expect(data.stdout + data.stderr).to.include('[REDACTED]');
        expect(data.stdout + data.stderr).not.to.include('split-sentinel');
        expect(data.stdout + data.stderr).not.to.include('continuation');
        expect(output.tail()).not.to.include('split-sentinel');
      }
    });
  }

  it('preserves UTF-8, safe live lines, streams and an unterminated final line', function() {
    const {data, output} = capture();
    for (const byte of Buffer.from('Готово 🙂\n')) {output.write('stdout', Buffer.from([byte]));}
    expect(data.stdout).to.equal('Готово 🙂\n');
    output.write('stderr', Buffer.from('last diagnostic'));
    expect(data.stderr).to.equal('');
    output.end();
    output.end();
    output.write('stderr', Buffer.from('late ignored data'));
    expect(data.stderr).to.equal('last diagnostic\n');
  });

  it('limits a flood of safe lines but retains a bounded final diagnostic tail', function() {
    const {data, output} = capture();
    for (let i = 0; i < 10000; i++) {output.write('stdout', Buffer.from('safe progress line\n'));}
    output.write('stderr', Buffer.from('final error\n'));
    output.end();
    expect(Buffer.byteLength(data.stdout + data.stderr)).to.be.at.most(128 * 1024 + 64);
    expect(data.stdout).to.include('[Output truncated: console limit]');
    expect(output.tail()).to.include('final error');
    expect(output.tail().length).to.be.at.most(4096);
  });

  it('discards an oversized ambiguous line without leaking its later suffix', function() {
    const {data, output} = capture();
    output.write('stdout', Buffer.from('x'.repeat(1000000)));
    output.write('stdout', Buffer.from('password=large-sentinel\n'));
    output.end();
    expect(data.stdout).to.equal('[Output truncated: unterminated or ambiguous line]\n');
    expect(output.tail()).not.to.include('large-sentinel');
  });
});
