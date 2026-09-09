'use strict';

const {setTimeout: delay} = require('node:timers/promises');

async function main() {
  const stream = process.env.VERIFY_OUTPUT_STREAM === 'stderr' ? process.stderr : process.stdout;
  stream.write('safe child context\n');
  if (process.env.VERIFY_OUTPUT_CASE === 'flood') {
    stream.write('safe progress line\n'.repeat(10000));
    stream.write('final unterminated diagnostic');
    process.exitCode = 1;
    return;
  }
  for (const chunk of ['pass', 'word', '\n', '=stream-output-sentinel\n', 'unlabelled-continuation\n']) {
    stream.write(chunk);
    await delay(10);
  }
  process.exitCode = 1;
}

main().catch(() => {process.exitCode = 1;});
