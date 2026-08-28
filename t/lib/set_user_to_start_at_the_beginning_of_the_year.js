
'use strict';

const
  openPageFunc   = require('./open_page'),
  userInfoFunc   = require('./user_info'),
  submitFormFunc = require('./submit_form'),
  config           = require('./config'),
  dayjs = require('../../lib/util/date');

const getUserId = ({userId,email,driver}) => userId
  ? Promise.resolve(userId)
  : userInfoFunc({email,driver})
    .then(({user : {id}}) => Promise.resolve(id));

module.exports = ({
  driver,
  email,
  userId=null,
  year=dayjs.utc().year(),
  applicationHost=config.get_application_host(),
  overwriteDate=null,
}) =>
  getUserId({userId,email,driver})
    .then(userId => openPageFunc({driver, url:`${applicationHost}users/edit/${userId}/`}))
    .then(() => submitFormFunc({
      driver,
      form_params : [{
        selector: 'input#start_date_inp',
        value: (overwriteDate ? overwriteDate.format('YYYY-MM-DD') : `${year}-01-01`),
      }],
      submit_button_selector : 'button#save_changes_btn',
      message : /Details for .* were updated/,
    }))
    .then(() => openPageFunc({driver, url:applicationHost}))
    .then(() => Promise.resolve({driver}));
