'use strict';

const
  validator      = require('../util/validator'),
  config         = require('../config'),
  branding       = require('../branding'),
  dayjs      = require('../util/date'),
  EmailTransport = require('../email'),
  authDomain     = require('../auth'),
  features       = require('../features'),
  authLog        = require('../util/auth_log'),
  logger         = require('../middleware/request_logger');

const authSecurity = require('../middleware/auth_security');

const sso = authDomain.providers.sso;
const authPolicy = authDomain.policy;

const getSsoLoginPageContext = () => {
  if (!features.isEnabled('sso_authentication')) {
    return Promise.resolve({
      has_sso_companies: false,
      direct_sso_available: false,
      default_sso_login_url: null,
    });
  }

  return sso.getSsoLoginPageContext();
};

const isSelfSignupEnabled = function() {
  if (typeof process.env.ALLOW_CREATE_NEW_ACCOUNTS !== 'undefined') {
    return process.env.ALLOW_CREATE_NEW_ACCOUNTS === true
      || process.env.ALLOW_CREATE_NEW_ACCOUNTS === 'true';
  }

  return config.get('allow_create_new_accounts') === true
    || config.get('allow_create_new_accounts') === 'true';
};

const get_url_to_site_root_for_anonymous_session = function(req) {
  return req.get('host').indexOf('app.timeoff') < 0
    ? '/'
    : branding.get().promotionWebsiteDomain;
};

module.exports = function(passport) {

  const express = require('express');
  const router  = express.Router();
  const authRateLimit = authSecurity.createAuthRateLimit();

  router.get('/login/sso/metadata/saml/:companyId', async function(req, res, next) {
    if (!features.isEnabled('sso_authentication')) {
      return res.status(404).send('Not found');
    }

    try {
      return await sso.renderSamlMetadata(req, res);
    } catch (error) {
      return next(error);
    }
  });

  router.get(
    '/login',
    authSecurity.setAuthSecurityHeaders,
    authSecurity.attachCsrfToken,
    async function(req, res, next){
      try {
        const sso_login = await getSsoLoginPageContext();

        return res.render('login', {
          allow_create_new_accounts: isSelfSignupEnabled(),
          sso_login : sso_login,
          title : branding.get().name,
          url_to_the_site_root : get_url_to_site_root_for_anonymous_session(req),
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.get(
    '/login/sso',
    authSecurity.setAuthSecurityHeaders,
    authSecurity.attachCsrfToken,
    async function(req, res, next){
      if (!features.isEnabled('sso_authentication')) {
        req.session.flash_error(req.t('features.messages.disabled'));
        return res.redirect_with_session('/login/');
      }

      try {
        const sso_login = await getSsoLoginPageContext();

        return res.render('login_sso', {
          allow_create_new_accounts: isSelfSignupEnabled(),
          sso_login : sso_login,
          title : branding.get().name,
          url_to_the_site_root : get_url_to_site_root_for_anonymous_session(req),
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.post(
    '/login',
    authSecurity.setAuthSecurityHeaders,
    authRateLimit,
    authSecurity.verifyCsrfToken,
    function(req, res, next) {
    const loginEmail = req.body && (req.body.email || req.body.username);

    passport.authenticate('local', function(err, user, info) {
      if (err) { return next(err); }

      if (!user) {
        if (info && info.use_sso && features.isEnabled('sso_authentication')) {
          authLog.logAuthEvent('info', 'login.redirected_to_sso', {
            flow: 'local',
            reason: info.auth_reason || 'sso_required',
            email: authLog.maskEmail(loginEmail),
            request: authLog.getRequestMeta(req),
          });
          return sso.startSsoLogin(req, res)
            .catch(function(error) {
              authLog.logAuthEvent('error', 'login.redirect_to_sso_failed', {
                flow: 'local',
                reason: 'sso_redirect_failed',
                email: authLog.maskEmail(loginEmail),
                request: authLog.getRequestMeta(req),
                error: authLog.getErrorMeta(error),
              });
              logger.error('sso_redirect_failed', {
                message: error && error.message || String(error),
                stack  : error && error.stack,
              });
              req.session.flash_error(req.t(info.message_key || 'login.messages.useSsoLogin'));
              return res.redirect_with_session('/login/sso/');
            });
        }

        authLog.logAuthEvent('warn', 'login.failed', {
          flow: 'local',
          reason: info && info.auth_reason || 'invalid_credentials',
          email: authLog.maskEmail(loginEmail),
          request: authLog.getRequestMeta(req),
        });
        req.session.flash_error(req.t(info && info.message_key || 'login.messages.invalidCredentials'));
        return res.redirect_with_session('/login/');
      }

      return req.logIn(user, function(err) {
        if (err) { return next(err); }
        req.install_flash_messages();

        authLog.logAuthEvent('info', 'login.succeeded', {
          flow: authPolicy.resolveSuccessfulLoginFlow(user),
          userId: user.id,
          companyId: user.companyId || user.company && user.company.id || null,
          request: authLog.getRequestMeta(req),
        });

        req.session.flash_message(req.t('login.messages.welcomeBack', {
          name: user.name
        }));

        return res.redirect_with_session('/');
      });
    })(req, res, next);
  });

  router.post(
    '/login/sso',
    authSecurity.setAuthSecurityHeaders,
    authRateLimit,
    authSecurity.verifyCsrfToken,
    async function(req, res, _next) {
      if (!features.isEnabled('sso_authentication')) {
        req.session.flash_error(req.t('features.messages.disabled'));
        return res.redirect_with_session('/login/');
      }

      try {
        return await sso.startSsoLogin(req, res);
      } catch (error) {
        authLog.logAuthEvent('error', 'sso.login_start_failed', {
          flow: 'sso',
          reason: 'sso_start_failed',
          email: authLog.maskEmail(req.body && (req.body.email || req.body.username)),
          request: authLog.getRequestMeta(req),
          error: authLog.getErrorMeta(error),
        });
        logger.error('sso_login_start_failed', {
          message: error && error.message || String(error),
          stack  : error && error.stack,
        });
        req.session.flash_error(req.t('login.messages.ssoFailed'));
        return res.redirect_with_session('/login/sso/');
      }
    }
  );

  router.get('/login/sso/direct', async function(req, res, _next) {
    if (!features.isEnabled('sso_authentication')) {
      req.session.flash_error(req.t('features.messages.disabled'));
      return res.redirect_with_session('/login/');
    }

    try {
      return await sso.startSsoLogin(req, res, {
        direct : true,
      });
    } catch (error) {
      authLog.logAuthEvent('error', 'sso.direct_start_failed', {
        flow: 'sso',
        reason: 'direct_sso_start_failed',
        request: authLog.getRequestMeta(req),
        error: authLog.getErrorMeta(error),
      });
      logger.error('sso_direct_start_failed', {
        message: error && error.message || String(error),
        stack  : error && error.stack,
      });
      req.session.flash_error(req.t('login.messages.ssoFailed'));
      return res.redirect_with_session('/login/');
    }
  });

  router.get('/login/sso/tenant/:companyAlias', async function(req, res, _next) {
    if (!features.isEnabled('sso_authentication')) {
      req.session.flash_error(req.t('features.messages.disabled'));
      return res.redirect_with_session('/login/');
    }

    try {
      return await sso.startSsoLogin(req, res, {
        direct : true,
        companyAlias : req.params.companyAlias,
      });
    } catch (error) {
      authLog.logAuthEvent('error', 'sso.tenant_start_failed', {
        flow: 'sso',
        reason: 'tenant_sso_start_failed',
        companyAlias: req.params.companyAlias,
        request: authLog.getRequestMeta(req),
        error: authLog.getErrorMeta(error),
      });
      logger.error('sso_tenant_start_failed', {
        message: error && error.message || String(error),
        stack  : error && error.stack,
      });
      req.session.flash_error(req.t('login.messages.ssoFailed'));
      return res.redirect_with_session('/login/');
    }
  });

  router.get('/login/sso/callback', async function(req, res, _next) {
    if (!features.isEnabled('sso_authentication')) {
      req.session.flash_error(req.t('features.messages.disabled'));
      return res.redirect_with_session('/login/');
    }

    try {
      return await sso.handleOidcCallback(req, res);
    } catch (error) {
      authLog.logAuthEvent('error', 'sso.oidc_callback_failed', {
        flow: 'sso',
        provider: 'oidc',
        reason: 'oidc_callback_failed',
        request: authLog.getRequestMeta(req),
        error: authLog.getErrorMeta(error),
      });
      logger.error('sso_oidc_callback_failed', {
        message: error && error.message || String(error),
        stack  : error && error.stack,
      });
      req.session.flash_error(req.t('login.messages.ssoFailed'));
      return res.redirect_with_session('/login/sso/');
    }
  });

  router.post('/login/sso/callback/saml', async function(req, res, _next) {
    if (!features.isEnabled('sso_authentication')) {
      req.session.flash_error(req.t('features.messages.disabled'));
      return res.redirect_with_session('/login/');
    }

    try {
      return await sso.handleSamlCallback(req, res);
    } catch (error) {
      authLog.logAuthEvent('error', 'sso.saml_callback_failed', {
        flow: 'sso',
        provider: 'saml',
        reason: 'saml_callback_failed',
        request: authLog.getRequestMeta(req),
        error: authLog.getErrorMeta(error),
      });
      logger.error('sso_saml_callback_failed', {
        message: error && error.message || String(error),
        stack  : error && error.stack,
      });
      req.session.flash_error(req.t('login.messages.ssoFailed'));
      return res.redirect_with_session('/login/sso/');
    }
  });

  router.get('/logout', async function(req, res){

      if ( !req.user ) {
          return res.redirect_with_session(303, '/');
      }

      // Default logout is local-only so the upstream SSO session can still be reused.
      // passport 0.6+ требует колбэк у req.logout()
      await new Promise((resolve, reject) => req.logout(err => err ? reject(err) : resolve()));
      await sso.destroySession(req);

      return res.redirect(res.locals.url_to_the_site_root);
  });

  router.get('/logout/sso', async function(req, res){

      if ( !req.user ) {
          return res.redirect_with_session(303, '/');
      }

      let logoutRedirect = null;

      try {
        logoutRedirect = await sso.performOidcLogout(req);
      } catch (error) {
        logger.error('sso_oidc_logout_url_failed', {
          message: error && error.message || String(error),
          stack  : error && error.stack,
        });
      }

      // passport 0.6+ требует колбэк у req.logout()
      await new Promise((resolve, reject) => req.logout(err => err ? reject(err) : resolve()));
      await sso.destroySession(req);

      return res.redirect(logoutRedirect || res.locals.url_to_the_site_root);
  });

  router.get(
    '/register',
    authSecurity.setAuthSecurityHeaders,
    authSecurity.attachCsrfToken,
    function(req, res){
      if ( !isSelfSignupEnabled() ) {
        return res.redirect_with_session(res.locals.url_to_the_site_root);
      }

      if ( req.user ) {
        return res.redirect_with_session(303, '/');
      }

      res.locals.custom_java_script.push('/js/register.js');

      return res.render('register',{
        title                : req.t('register.title'),
        url_to_the_site_root : get_url_to_site_root_for_anonymous_session(req),
        countries            : config.get('countries'),
        timezones_available  : dayjs.tzNames(),
      });
    }
  );

  router.post(
    '/register',
    authSecurity.setAuthSecurityHeaders,
    authRateLimit,
    authSecurity.verifyCsrfToken,
    function(req, res, next){
      if ( !isSelfSignupEnabled() ) {
        return res.redirect_with_session(res.locals.url_to_the_site_root);
      }

      if ( req.user ) {
        return res.redirect_with_session(303, '/');
      }

      const email = req.body.email;
      if (!email){
          req.session.flash_error(req.t('login.messages.emailMissing'));
      } else if ( ! validator.isEmail(email)) {
          req.session.flash_error(req.t('login.messages.emailInvalid'));
      }

      const name = validator.trim(req.body.name);
      if (!name){
          req.session.flash_error(req.t('login.messages.nameMissing'));
      }

      const lastname = validator.trim(req.body.lastname);
      if (!lastname) {
          req.session.flash_error(req.t('login.messages.lastNameMissing'));
      }

      const company_name = validator.trim(req.body.company_name);
      if (!company_name) {
          req.session.flash_error(req.t('login.messages.companyNameMissing'));
      }

      const password = req.body.password;
      if (!password) {
          req.session.flash_error(req.t('login.messages.passwordBlank'));
      } else if ( password !== req.body.password_confirmed ) {
          req.session.flash_error(req.t('login.messages.passwordMismatch'));
      }

      const country_code = req.body.country;
      if (! validator.matches(country_code, /^[a-z]{2}/i) ){
          req.session.flash_error(req.t('login.messages.countryInvalid'));
      }

      const timezone = validator.trim(req.body.timezone);
      if ( ! dayjs.tzNames().find(tz_str => tz_str === timezone) ) {
        req.session.flash_error(req.t('login.messages.timezoneUnknown'));
      }

      if ( req.session.flash_has_errors() ) {
          return res.redirect_with_session('/register/');
      }

      return req.app.get('db_model').User.register_new_admin_user({
          email        : email.toLowerCase(),
          password     : password,
          name         : name,
          lastname     : lastname,
          company_name : company_name,
          country_code : country_code,
          timezone     : timezone,
      })
      .then(function(user){
        const email = new EmailTransport();

        return email.promise_registration_email({
          user : user,
        })
        .then(function(){
          return Promise.resolve(user);
        });
      })
      .then(function(user){
        req.logIn(user, function(err) {
          if (err) { return next(err); }

          // passport 0.6+ пересоздаёт сессию при логине — переустанавливаем flash-хелперы
          req.install_flash_messages();

          req.session.flash_message(
              req.t('login.messages.registrationComplete')
          );

          return res.redirect_with_session('/');
        });

      })
      .catch(function(error){
          logger.error('registration_failed', {
            email  : authLog.maskEmail(email),
            message: error && error.message || String(error),
          });

          req.session.flash_error(
            req.t('login.messages.registrationFailed', {
              reason: error.show_to_user ? error : req.t('login.messages.contactSupport')
            })
          );

          return res.redirect_with_session('/register/');
      });

    }
  );

  router.get(
    '/forgot-password/',
    authSecurity.setAuthSecurityHeaders,
    authSecurity.attachCsrfToken,
    async function(req, res, next){
      try {
        const sso_login = await getSsoLoginPageContext();

        return res.render('forgot_password',{
          title : req.t('forgotPassword.title'),
          url_to_the_site_root : get_url_to_site_root_for_anonymous_session(req),
          sso_login : sso_login,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.post(
    '/forgot-password/',
    authSecurity.setAuthSecurityHeaders,
    authRateLimit,
    authSecurity.verifyCsrfToken,
    function(req, res){
    let email = req.body.email;

    if (!email){
      req.session.flash_error(req.t('login.messages.emailMissing'));

    } else if ( ! validator.isEmail(email)) {
      req.session.flash_error(req.t('login.messages.emailInvalid'));
    }

    if ( req.session.flash_has_errors() ) {
      return res.redirect_with_session('./');
    }

    const success_msg = req.t('login.messages.forgotPasswordSent');

    email = email.toLowerCase();

    return req.app.get('db_model').User.find_by_email(email)
      .then(function(user){

        if (!user) {
          req.session.flash_message(success_msg);

          const error = new Error('');
          error.do_not_report = true;
          throw error;
        }

        return Promise.resolve(user);
      })
      .then(function(user){
        return user.getCompany()
          .then(function(company) {
            user.company = company;
            return user;
          });
      })
      .then(function(user){
        if (user.company && user.company.sso_auth_enabled && features.isEnabled('sso_authentication')) {
          req.session.flash_warning(req.t('login.messages.useSsoPasswordRecovery'));

          const error = new Error('');
          error.do_not_report = true;
          error.redirect_to = '/login/sso/';
          throw error;
        }

        return Promise.resolve(user);
      })
      .then(function(user){
        const Email = new EmailTransport();

        return Email.promise_forgot_password_email({
          user : user,
        });
      })
      .then(function(){
          req.session.flash_message(success_msg);
          return res.redirect_with_session('./');
      })
      .catch(function(error){

        if (error.do_not_report ){
          return res.redirect_with_session(error.redirect_to || './');
        }

        logger.error('forgot_password_failed', {
          message: error && error.message || String(error),
        });
        req.session.flash_error(req.t('login.messages.forgotPasswordFailed'));
        return res.redirect_with_session('./');
      });

    }
  );

  router.get(
    '/reset-password/',
    authSecurity.setAuthSecurityHeaders,
    authSecurity.attachCsrfToken,
    async function(req, res){
      const token = req.query.t;

      try {
        const user = await req.app
          .get('db_model')
          .User
          .get_user_by_reset_password_token(token);

        if (! user) {
          req.session.flash_error(req.t('login.messages.resetLinkUnknown'));
          return res.redirect_with_session('/forgot-password/');
        }

        return res.render('reset_password',{
          title : req.t('resetPassword.title'),
          url_to_the_site_root : get_url_to_site_root_for_anonymous_session(req),
          token : token,
        });
      } catch (error) {
        logger.error('reset_password_token_invalid', {
          message: error && error.message || String(error),
        });
        req.session.flash_error(req.t('login.messages.resetPasswordFailed'));
        return res.redirect_with_session('/forgot-password/');
      }
    }
  );

  router.post(
    '/reset-password/',
    authSecurity.setAuthSecurityHeaders,
    authRateLimit,
    authSecurity.verifyCsrfToken,
    async function(req, res){

    const token        = req.body.t,
    password         = req.body.password,
    confirm_password = req.body.confirm_password;

    if (!password || !String(password).trim()) {
      req.session.flash_error(req.t('login.messages.passwordBlank'));
      return res.redirect_with_session('/reset-password/?t='+token);
    }

    if (password !== confirm_password) {
      req.session.flash_error(req.t('login.messages.resetPasswordMismatch'));
      return res.redirect_with_session('/reset-password/?t='+token);
    }

    try {
      const user = await req.app
        .get('db_model')
        .User
        .get_user_by_reset_password_token(token);

        if (! user) {
          req.session.flash_error(req.t('login.messages.resetLinkUnknown'));
          return res.redirect_with_session('/forgot-password/');
        }

      user.password = req.app.get('db_model').User.hashify_password(password);
      await user.save();

      const Email = new EmailTransport();
      await Email.promise_reset_password_email({
        user : user,
      });

      req.session.flash_message(req.t('login.messages.resetPasswordUseNew'));
      return res.redirect_with_session('/login/');
    } catch (error) {
      logger.error('reset_password_failed', {
        message: error && error.message || String(error),
      });
      req.session.flash_error(req.t('login.messages.resetPasswordFailed'));
      return res.redirect_with_session('/forgot-password/');
    }
    }
  );

  return router;
};
