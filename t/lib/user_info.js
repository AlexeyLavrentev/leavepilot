
/*

*/

const { promisify } = require('util');

'use strict';// Function that is executed on the client,
// it relies on presence of jQuery and window.VPP_email
var func_to_inject = function() {
  var callback = arguments[arguments.length - 1];

  $.ajax({
    url: '/users/search/',
    type: 'post',
    data: {
      email : window.VPP_email,
    },
    headers: {
      Accept : "application/json",
    },
    dataType: 'json',
    success: function (data) {
      callback(data);
    }
  });
};


var user_info_func = promisify( function(args, callback){

  var
    result_callback = callback,
    driver          = args.driver,
    email           = args.email;

  if ( ! driver ) {
    throw "'driver' was not passed into the user_info!";
  }

  if ( ! email ) {
    throw "'email' was not passed into the user_info!";
  }

  driver
    .executeScript('window.VPP_email = "'+email+'";')
    .then(function(){
      return driver.executeAsyncScript(func_to_inject);
    })
    .then(function(users){
      var user = users.length > 0 ? users[0] : {};
      result_callback(null, {
        driver : driver,
        user   : user,
      });
    })
    .catch(function(err){
      result_callback(err);
    });

});

module.exports = function(args){
  return user_info_func(args);
};
