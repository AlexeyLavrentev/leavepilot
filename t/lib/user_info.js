'use strict';

module.exports = async function({driver, email}) {
  if (!driver) { throw new Error("'driver' was not passed into the user_info!"); }
  if (!email) { throw new Error("'email' was not passed into the user_info!"); }

  // WebDriver serializes arguments as data; never interpolate email into source.
  const result = await driver.executeAsyncScript(function(email) {
    const callback = arguments[arguments.length - 1];
    $.ajax({
      url: '/users/search/',
      type: 'post',
      data: {email},
      headers: {Accept: 'application/json'},
      dataType: 'json',
      success: function(users) { callback({users}); },
      error: function(xhr) { callback({error: true, status: xhr.status}); },
    });
  }, email);

  if (result && result.error) {
    throw new Error('User search failed (HTTP ' + result.status + ')');
  }
  if (!result || !Array.isArray(result.users)) { throw new Error('Invalid user search response'); }
  return {driver, user: result.users[0] || {}};
};
