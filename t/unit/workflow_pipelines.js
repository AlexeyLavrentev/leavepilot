'use strict';

/*
  GitHub Actions runs each `run:` step with `bash -e {0}`. The -e is there; what
  is not is pipefail, and without it the status of `a | b` is b's alone. So

    node bin/db_update.js | tee run1.log

  reports success whatever db_update did, because tee always succeeds.

  The migration smoke job was partly covered by accident: the line under that
  one greps the log for a marker db_update prints only after every migration has
  run, so a migration that throws is still caught. What is not caught is
  anything the script does after printing it - the SSO secret audit, which ends
  in process.exit(1) of its own - and nothing at all if that logging is ever
  reordered. A job whose safety rests on the position of a log line is one that
  will go quiet without telling anybody.

  Asserted over the workflows rather than fixed once, since piping a command
  into tee to keep its output is a natural thing to write and the next one would
  be silent in the same way.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const workflowsDir = path.join(__dirname, '..', '..', '.github', 'workflows');

const workflows = fs.readdirSync(workflowsDir)
  .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map(name => ({name, source: fs.readFileSync(path.join(workflowsDir, name), 'utf8')}));

/*
  Every `run: |` block, with its body. Enough of a parse for this: the body is
  the run of lines indented further than the `run:` key itself.
*/
const runBlocks = workflow => {
  const lines = workflow.source.split('\n');
  const blocks = [];

  lines.forEach((line, index) => {
    const opener = line.match(/^(\s*)run:\s*\|\s*$/);

    if (!opener) {
      return;
    }

    const indent = opener[1].length;
    const body = [];

    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const next = lines[cursor];

      if (next.trim() === '') {
        body.push(next);
        continue;
      }

      if (next.search(/\S/) <= indent) {
        break;
      }

      body.push(next);
    }

    blocks.push({workflow: workflow.name, line: index + 1, body: body.join('\n')});
  });

  return blocks;
};

// A pipe that feeds a command, not `||`, and not one inside a comment.
const pipesIntoAnotherCommand = body => body
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .some(line => /[^|]\|[^|]/.test(line));

describe('Workflow shell pipelines', function() {

  const allBlocks = workflows.reduce((blocks, workflow) => blocks.concat(runBlocks(workflow)), []);

  it('has workflows and run blocks to check', function() {
    expect(workflows.length).to.be.above(0);
    expect(allBlocks.length).to.be.above(5);
  });

  it('sets pipefail in every step that pipes one command into another', function() {
    const offenders = allBlocks
      .filter(block => pipesIntoAnotherCommand(block.body))
      .filter(block => !/set -o pipefail|set -eo pipefail|set -euo pipefail/.test(block.body))
      .map(block => block.workflow + ':' + block.line);

    expect(offenders).to.deep.equal(
      [],
      'the left-hand side of these pipelines can fail without failing the step'
    );
  });

  // The assertion above is satisfied by a workflow with no pipelines at all, so
  // the one this was written for has to still be there.
  it('still has the piped migration steps it was written for', function() {
    const piped = allBlocks.filter(block => /db_update\.js \| tee/.test(block.body));

    expect(piped.length).to.equal(2);
    piped.forEach(block => expect(block.body).to.match(/set -o pipefail/));
  });
});
