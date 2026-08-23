'use strict';

const validator = require('../util/validator');

function buildUserValidationError(message) {
  const error = new Error(message || 'Validation failed');
  error.show_to_user = true;
  return error;
}

function getSubmittedAuthenticationFormValues(req) {
  return {
    ldap_auth_enabled : validator.toBoolean(req.body.ldap_auth_enabled),
    ldap_config : {
      url                     : validator.trim(req.body.url),
      binddn                  : validator.trim(req.body.binddn),
      bindcredentials         : validator.trim(req.body.bindcredentials),
      searchbase              : validator.trim(req.body.searchbase),
      allow_unauthorized_cert : validator.toBoolean(req.body.allow_unauthorized_cert),
    },
    sso_auth_enabled : validator.toBoolean(req.body.sso_auth_enabled),
    sso_auth_provider : validator.trim(req.body.sso_auth_provider || 'oidc').toLowerCase() || 'oidc',
    sso_auth_config : {
      login_alias            : validator.trim(req.body.sso_login_alias).toLowerCase(),
      issuer_url             : validator.trim(req.body.sso_issuer_url),
      client_id              : validator.trim(req.body.sso_client_id),
      client_secret          : validator.trim(req.body.sso_client_secret),
      scope                  : validator.trim(req.body.sso_scope || 'openid profile email'),
      email_claim            : validator.trim(req.body.sso_email_claim || 'email'),
      email_domains          : validator.trim(req.body.sso_email_domains),
      auto_create_users      : validator.toBoolean(req.body.sso_auto_create_users),
      require_verified_email : validator.toBoolean(req.body.sso_require_verified_email),
      entry_point            : validator.trim(req.body.sso_entry_point),
      idp_cert               : validator.trim(req.body.sso_idp_cert),
      identifier_format      : validator.trim(req.body.sso_identifier_format),
      email_attribute        : validator.trim(req.body.sso_email_attribute || 'email'),
      sp_entity_id           : validator.trim(req.body.sso_sp_entity_id),
    },
  };
}

function getAuthenticationSettingsFormData(args) {
  const company = args.company;
  const req = args.req;
  const useSubmittedValues = args.useSubmittedValues;
  const ssoService = args.ssoService;
  const submittedValues = useSubmittedValues
    ? getSubmittedAuthenticationFormValues(req)
    : null;

  return {
    sso_available : !!args.ssoAvailable,
    company : Object.assign({}, company.toJSON ? company.toJSON() : company, {
      ldap_auth_enabled : submittedValues
        ? submittedValues.ldap_auth_enabled
        : company.ldap_auth_enabled,
      sso_auth_enabled : submittedValues
        ? submittedValues.sso_auth_enabled
        : company.sso_auth_enabled,
    }),
    ldap_config : submittedValues
      ? submittedValues.ldap_config
      : company.get('ldap_auth_config'),
    sso : submittedValues
      ? Object.assign({}, ssoService.getPublicSsoSummary(company), {
        provider : submittedValues.sso_auth_provider,
        config : submittedValues.sso_auth_config,
      })
      : ssoService.getPublicSsoSummary(company),
  };
}

function renderAuthenticationSettingsPage(args) {
  const req = args.req;
  const res = args.res;
  const company = args.company;
  const statusCode = args.statusCode || 200;
  const formData = getAuthenticationSettingsFormData({
    company,
    req,
    ssoService: args.ssoService,
    ssoAvailable: args.ssoAvailable,
    useSubmittedValues: args.useSubmittedValues,
  });

  if (req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }

  res.locals.custom_java_script.push('/js/settings_authentication.js');

  return res.status(statusCode).render('settings_company_authentication', formData);
}

function getAndValidateLdapAuthConfiguration(args) {
  const req = args.req;
  const url = validator.trim(req.body.url);
  const binddn = validator.trim(req.body.binddn);
  const bindcredentials = validator.trim(req.body.bindcredentials);
  const searchbase = validator.trim(req.body.searchbase);
  const ldap_auth_enabled = validator.toBoolean(req.body.ldap_auth_enabled);
  const allow_unauthorized_cert = validator.toBoolean(req.body.allow_unauthorized_cert);
  const password_to_check = validator.trim(req.body.password_to_check);

  if (ldap_auth_enabled && !validator.matches(url, /^ldaps?:\/\/[a-z0-9.-]+:\d+$/i)) {
    req.session.flash_error(req.t('settings.messages.ldapUrlInvalid'));
  }

  if (req.session.flash_has_errors()) {
    throw buildUserValidationError();
  }

  return {
    ldap_config : {
      url                     : url,
      binddn                  : binddn,
      bindcredentials         : bindcredentials,
      searchbase              : searchbase,
      allow_unauthorized_cert : allow_unauthorized_cert,
    },
    ldap_auth_enabled : ldap_auth_enabled,
    password_to_check : password_to_check,
  };
}

function getAndValidateSsoAuthConfiguration(args) {
  const req = args.req;
  const sso_auth_enabled = validator.toBoolean(req.body.sso_auth_enabled);
  const sso_auth_provider = validator.trim(req.body.sso_auth_provider || 'oidc').toLowerCase();
  const login_alias = validator.trim(req.body.sso_login_alias).toLowerCase();
  const issuer_url = validator.trim(req.body.sso_issuer_url);
  const client_id = validator.trim(req.body.sso_client_id);
  const client_secret = validator.trim(req.body.sso_client_secret);
  const scope = validator.trim(req.body.sso_scope || 'openid profile email');
  const email_claim = validator.trim(req.body.sso_email_claim || 'email');
  const require_verified_email = validator.toBoolean(req.body.sso_require_verified_email);
  const entry_point = validator.trim(req.body.sso_entry_point);
  const idp_cert = validator.trim(req.body.sso_idp_cert);
  const identifier_format = validator.trim(req.body.sso_identifier_format);
  const email_attribute = validator.trim(req.body.sso_email_attribute || 'email');
  const email_domains = validator.trim(req.body.sso_email_domains);
  const auto_create_users = validator.toBoolean(req.body.sso_auto_create_users);
  const sp_entity_id = validator.trim(req.body.sso_sp_entity_id);

  if (sso_auth_enabled && !validator.matches(sso_auth_provider, /^(oidc|saml)$/)) {
    req.session.flash_error(req.t('settings.messages.ssoProviderUnknown'));
  }

  if (sso_auth_enabled && login_alias && !validator.matches(login_alias, /^[a-z0-9][a-z0-9_-]{1,62}$/)) {
    req.session.flash_error(req.t('settings.messages.ssoLoginAliasInvalid'));
  }

  if (sso_auth_enabled && sso_auth_provider === 'oidc') {
    if (!validator.matches(issuer_url, /^https?:\/\/.+/i)) {
      req.session.flash_error(req.t('settings.messages.ssoIssuerInvalid'));
    }
    if (!client_id) {
      req.session.flash_error(req.t('settings.messages.ssoClientIdMissing'));
    }
  }

  if (sso_auth_enabled && sso_auth_provider === 'saml') {
    if (!validator.matches(entry_point, /^https?:\/\/.+/i)) {
      req.session.flash_error(req.t('settings.messages.ssoEntryPointInvalid'));
    }
    if (!idp_cert) {
      req.session.flash_error(req.t('settings.messages.ssoIdpCertMissing'));
    }
  }

  if (sso_auth_enabled && email_domains) {
    email_domains
      .split(/[\s,;]+/)
      .map(domain => validator.trim(domain).toLowerCase())
      .filter(Boolean)
      .forEach(domain => {
        if (!validator.isFQDN(domain)) {
          req.session.flash_error(req.t('settings.messages.ssoEmailDomainInvalid', { domain : domain }));
        }
      });
  }

  if (req.session.flash_has_errors()) {
    throw buildUserValidationError();
  }

  return {
    sso_auth_enabled : sso_auth_enabled,
    sso_auth_provider : sso_auth_provider,
    sso_auth_config : {
      login_alias            : login_alias,
      issuer_url             : issuer_url,
      client_id              : client_id,
      client_secret          : client_secret,
      scope                  : scope,
      email_claim            : email_claim,
      require_verified_email : require_verified_email,
      entry_point            : entry_point,
      idp_cert               : idp_cert,
      identifier_format      : identifier_format,
      email_attribute        : email_attribute,
      email_domains          : email_domains,
      auto_create_users      : auto_create_users,
      sp_entity_id           : sp_entity_id,
    },
  };
}

module.exports = {
  getAndValidateLdapAuthConfiguration,
  getAndValidateSsoAuthConfiguration,
  getAuthenticationSettingsFormData,
  getSubmittedAuthenticationFormValues,
  renderAuthenticationSettingsPage,
};
