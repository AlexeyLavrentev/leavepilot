
'use strict';

var expect = require('chai').expect,
_          = require('underscore'),
Email      = require('../../lib/email');

describe('Check Email', function(){

  it('Knows how to render and parse template', function(done){

    var email = new Email();

    Promise.resolve(email.promise_rendered_email_template({
      template_name : 'foobar',
      context : {
        user : {
          name : 'FOO',
          reload_with_session_details : function(){ Promise.resolve(1); },
        },
      },
    }))
    .then(function(email){

      expect(email.subject).to.be.equal('Email subject goes here');
      expect(email.body).to.match(/Hello FOO\./);

      done();
    });

  });

  it('Can silence fake email payloads during integration tests', async function(){
    var original_log = console.log;
    var original_silence_flag = process.env.SILENCE_PRETEND_EMAILS;
    var logged_messages = [];

    console.log = function(message){
      logged_messages.push(message);
    };
    process.env.SILENCE_PRETEND_EMAILS = 'true';

    try {
      await new Email().get_send_email()({to: 'test@example.com'});
      expect(logged_messages).to.deep.equal([]);
    } finally {
      console.log = original_log;
      if (typeof original_silence_flag === 'undefined') {
        delete process.env.SILENCE_PRETEND_EMAILS;
      } else {
        process.env.SILENCE_PRETEND_EMAILS = original_silence_flag;
      }
    }
  });

});
