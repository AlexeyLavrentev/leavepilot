
/*
 *  Module to encapsulate logic for passport instantiation used for
 *  authentication.
 *
 *  Exports function that return instance of passport object.
 *
 * */

'use strict';

const
  model     = require('../model/db'),
  passport      = require('passport'),
  LocalStrategy = require('passport-local').Strategy,
  BearerStrategy= require('passport-http-bearer').Strategy,
  getCompanyAdminByToken = require('./getCompanyAdminByToken'),
  authLog = require('../util/auth_log'),
  authPolicy = require('../auth/policy'),
  logger = require('../middleware/request_logger');

// In case if user is successfully logged in, make sure it is
// activated
function prepare_user_for_session(args) {
  const user = args.user,
      done = args.done;

  user.maybe_activate()
    .then(function(user){
      return user.reload_with_session_details();
    })
    .then(function(){
      done(null, user);
    });
}

function create_ldap_server_closer(ldap_server) {
  let closed = false;

  return function close_ldap_server_once() {
    if (closed) {
      return;
    }

    closed = true;
    ldap_server.close();
  };
}

// Function that performs authentication of given user object
// by given password.
// The method is callback based and the result is conveyed
// via provided callback function "done"
//
function authenticate_user(args){

  const user = args.user,
  password = args.password,
  done     = args.done,
  email    = user.email;

  // In case of LDAP authentification connect the LDAP server
  if (authPolicy.resolveUserPasswordAuthMode(user) === 'ldap') {

    Promise.resolve( user.company.get_ldap_server() )
      .then(function(ldap_server){
      const close_ldap_server = create_ldap_server_closer(ldap_server);

      try {
        ldap_server.authenticate(email, password, function (err, _u) {
          close_ldap_server();

          if (err) {
            authLog.logAuthEvent('warn', 'login.failed', {
              flow: 'ldap',
              reason: 'ldap_auth_failed',
              email: authLog.maskEmail(email),
              companyId: user.company && user.company.id || null,
              error: authLog.getErrorMeta(err),
            });
            return done(null, false, {
              auth_reason: 'ldap_auth_failed',
            });
          }
          return prepare_user_for_session({
            user : user,
            done : done,
          });
        });
      } catch (error) {
        close_ldap_server();
        throw error;
      }
    })
    .catch(function(error){
      logger.error('ldap_transport_error', {
        message: error && error.message || String(error),
      });

      done(null, false, {
        auth_reason: 'ldap_transport_error',
      });
    });

  // Users from SSO-enabled companies must authenticate via the SSO flow.
  } else if (authPolicy.resolveUserPasswordAuthMode(user) === 'sso') {
    logger.info('login_sso_required', {
      email  : authLog.maskEmail(email),
      companyId: user.company && user.company.id,
    });
    done(null, false, authPolicy.buildSsoRequiredLoginInfo());

  // Provided password is correct
  } else if (user.is_my_password(password)) {

    // Transparently upgrade legacy password hashes to the current algorithm.
    if (user.password_needs_rehash()) {
      user.password = model.User.hashify_password(password);
      user.save({ fields: ['password'] })
        .then(function() {
          prepare_user_for_session({ user : user, done : done });
        })
        .catch(function(error) {
          logger.error('password_hash_upgrade_failed', {
            email  : authLog.maskEmail(email),
            message: error && error.message || String(error),
          });
          prepare_user_for_session({ user : user, done : done });
        });
      return;
    }

    prepare_user_for_session({
      user : user,
      done : done,
    });

  // User exists but provided password does not match
  } else {
      logger.warn('login_invalid_password', {
        email: authLog.maskEmail(email),
      });
      done(null, false, {
        auth_reason: 'invalid_password',
      });
  }
}

function strategy_handler(email, password, done) {

  // Normalize email to be in lower case
  email = email.toLowerCase();

  model.User
    .find_by_email( email )
    .then(function(user){

      // Case when no user for provided email
      if ( ! user ) {
        logger.warn('login_user_not_found', {
          email: authLog.maskEmail(email),
        });

        // We need to abort the execution of current callback function
        // hence the return before calling "done" callback
        return done(null, false, {
          auth_reason: 'user_not_found',
        });
      }

      // Athenticate user by provided password
      return user.getCompany()
        .then(function(company){

          // We need to have company for user fetchef dow the line so query it now
          user.company = company;

          authenticate_user({
            user     : user,
            password : password,
            done     : done,
          });
        });
    })

    // there was unknown error when trying to retrieve user object
    .catch(function(error){
      logger.error('local_auth_error', {
        email  : authLog.maskEmail(email),
        message: error && error.message || String(error),
      });

      done(null, false, {
        auth_reason: 'local_auth_error',
      });
    });
}

module.exports = function(){

  passport.use(new LocalStrategy({ usernameField: 'email' }, strategy_handler));

  passport.use(new BearerStrategy((token, done) => {
    getCompanyAdminByToken({ token, model })
    .then(user => {
      if (!user) {
        done(null, false);
        return null;
      }
      return user.reload_with_session_details()
        .then(user => done(null, user));
    })
    .catch(error => {
      logger.warn('bearer_token_auth_failed', {
        message: error && error.message || String(error),
      });
      done(null, false);
    });
  }));

  // Define how user object is going to be flattered into session
  // after request is processed.
  // In session store we save only user ID
  passport.serializeUser(function(user, done) {
    done(null, user.id);
  });

  // Defines how the user object is restored based on data saved
  // in session storage.
  // Fetch user data from DB based on ID.
  passport.deserializeUser(function(id, done) {

    model.User.findOne({where : {id : id}}).then(function(user){
      if (!user) {
        done(null, false, { message : 'Session user not found' });
        return undefined;
      }
      return user.reload_with_session_details()
        .then(function(reloaded){
          done(null, reloaded);
        });
    })
    .catch(function(error){
      logger.error('session_user_fetch_failed', {
        userId : id,
        message: error && error.message || String(error),
      });

      done(null, false, { message : 'Failed to fetch session user' });
    });
  });

  return passport;
};
