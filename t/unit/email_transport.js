'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodemailer = require('nodemailer');

// Load the real mail facade without opening the application's database.
function loadEmail(settings, mailer = nodemailer) {
  const filename = path.resolve(__dirname, '../../lib/email.js');
  const module = {exports: {}};
  const dependencies = {
    'express-handlebars': {create: () => ({})},
    './view/helpers': () => ({}),
    './branding': {},
    './config': {get: key => settings[key]},
    nodemailer: mailer,
    './model/db': {},
    './email_template_paths': {},
    './model/comment': {},
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    __dirname: path.dirname(filename),
    process: {env: {SILENCE_PRETEND_EMAILS: 'true'}},
    console,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
  }, {filename});
  return new module.exports();
}

describe('configured email transport', function() {
  const message = {
    from: 'LeavePilot <sender@example.test>',
    to: 'Employee <employee@example.test>',
    subject: 'Leave request approved',
    html: '<p>Your leave request was approved.</p>',
  };

  it('returns a promise and renders mail with the real Nodemailer transport', async function() {
    const email = loadEmail({send_emails: true, email_transporter: {jsonTransport: true}});
    const resultPromise = email.get_send_email()(message);
    assert.equal(typeof resultPromise.then, 'function');
    const result = await resultPromise;
    assert.deepEqual(result.envelope, {from: 'sender@example.test', to: ['employee@example.test']});
    const rendered = JSON.parse(result.message);
    assert.equal(rendered.subject, message.subject);
    assert.equal(rendered.html, message.html);
  });

  it('propagates a transport rejection without replacing the original error', async function() {
    const expected = new Error('Synthetic delivery failure');
    const email = loadEmail({send_emails: true, email_transporter: {
      name: 'test-only', version: '1', send: (_mail, callback) => callback(expected),
    }});
    await assert.rejects(email.get_send_email()(message), error => error === expected);
  });

  it('preserves disabled-mail mode without constructing a transporter', async function() {
    const email = loadEmail({send_emails: false}, {
      createTransport: () => { throw new Error('Disabled mail must not create a transport'); },
    });
    assert.equal(await email.get_send_email()(message), undefined);
  });

  it('honors Nodemailer file-access restrictions without reading an attachment', async function() {
    const email = loadEmail({send_emails: true, email_transporter: {
      streamTransport: true, buffer: true, disableFileAccess: true,
    }});
    await assert.rejects(email.get_send_email()({
      ...message, attachments: [{filename: 'blocked.txt', path: __filename}],
    }), /File access rejected/i);
  });
});
