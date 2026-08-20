/*
 *
 * */

"use strict";

const
  express   = require('express'),
  router    = express.Router(),
  validator = require('../util/validator'),
  dayjs    = require('../util/date'),
  config    = require('../config'),
  Exception = require('../error'),
  {extractUserErrorMessage, extractSystemErrorMessage} = Exception,
  CompanyRemover = require('../model/company/remover'),
  teamViewCache = require('../cache/team_view_cache'),
  {calculateCarryOverAllowance} = require('../model/calculateCarryOverAllowance'),
  {v4: uuidv4} = require('uuid'),
  _         = require('underscore'),
  authDomain = require('../auth');
const diagnostics = require('../diagnostics');
const features = require('../features');
const branding = require('../branding');
const licenseStatusView = require('../license_status_view');
const { findDuplicateLeaveTypeName } = require('../model/leave_type_validation');

const
  CompanyExporter = require('../model/company/exporter');
const { sorter } = require('../util');
const ssoService = authDomain.providers.sso;
const authSettings = authDomain.settings;

// Make sure that current user is authorized to deal with settings
router.all(/.*/, require('../middleware/ensure_user_is_admin'));


router.get('/general/', async (req, res) => {
  res.locals.custom_java_script.push(
    '/js/settings_general.js'
  );

  res.locals.custom_css.push(
    '/css/bootstrap-datepicker3.standalone.css'
  );

  const company = await req.user.getCompany({
    scope: ['with_leave_types'],
  });

  const schedule = await company.promise_schedule();

  res.render('general_settings', {
    title: req.t('generalSettings.title'),
    company,
    schedule,
    countries: config.get('countries'),
    timezones_available: dayjs.tzNames(),
    carryOverOptions: getAvailableCarriedOverOptions(),
    yearCurrent: dayjs.utc().year(),
    yearPrev: dayjs.utc().add(-1, 'y').year(),
    leave_types: company.leave_types.sort((a, b) => sorter(a.name, b.name)),
    licenseStatus: licenseStatusView.mapLicenseStatusToUiBucket(
      features.getLicenseStatus(),
      branding.get()
    ),
  });
});

router.post('/company/', function(req, res){

  const
    name              = validator.trim(req.body['name']),
    country_code      = validator.trim(req.body['country']),
    date_format       = validator.trim(req.body['date_format']),
    timezone          = validator.trim(req.body['timezone']),
    carriedOverDays   = validator.trim(req.body['carry_over']),
    share_all_absences= validator.toBoolean(
      req.body['share_all_absences']
    ),
    isTeamViewHidden = validator.toBoolean(
      req.body['is_team_view_hidden']
    );

  if (!validator.isAlphanumeric(country_code)){
    req.session.flash_error(req.t('settings.messages.countryInvalid'));
  }

  if (!name) {
    req.session.flash_error(req.t('settings.messages.companyNameRequired'));
  }

  if ( ! dayjs.tzNames().find(tz_str => tz_str === timezone) ) {
    req.session.flash_error(req.t('settings.messages.timezoneUnknown'));
  }

  if ( ! validator.isNumeric(carriedOverDays)) {
    req.session.flash_error(req.t('settings.messages.carryOverInvalid'));
  }

  // In case of validation error redirect back to edit form
  if ( req.session.flash_has_errors() ) {
    return res.redirect_with_session('/settings/general/');
  }

  req.user.getCompany()

  // Validate provided date format
  .then(function(company){

    if ( _.indexOf( company.get_available_date_formats(), date_format ) < 0 ) {
      var error_msg = req.t('settings.messages.dateFormatUnknown');
      req.session.flash_error(error_msg);
      throw new Error(error_msg);
    }

    return Promise.resolve( company );
  })

  .then(company => {
    company.name              = name;
    company.country           = country_code;
    company.share_all_absences= share_all_absences;
    company.date_format       = date_format;
    company.timezone          = timezone;
    company.carry_over        = carriedOverDays;
    company.is_team_view_hidden = isTeamViewHidden;

    return company.save()
      .then(() => teamViewCache.bumpCompanyVersion(company.id));
  })
  .then(function(){
      req.session.flash_message(req.t('settings.messages.companyUpdated'));
      return res.redirect_with_session('/settings/general/');
  })
  .catch(function(error){
    console.log(
      `An error occurred when trying to edit company for user ${req.user.id}: ${error} at ${error.stack}`
    );

    req.session.flash_error(req.t('settings.messages.companyUpdateFailed'));

    return res.redirect_with_session('/settings/general/');
  });
});

router.post('/carryOverUnusedAllowance/', (req, res) => {
  req.user
    .getCompany()
    .then(company => company.getUsers())
    .then(users => calculateCarryOverAllowance({users}))
    .then(() => req.session.flash_message(req.t('settings.messages.carryOverSuccess')))
    .catch(error => {
      const logMarker = uuidv4();
      console.log(
        `[${logMarker}] An error occurred while trying to carry over unused allowance by user ${req.user.id}: ${error} at ${error.stack}`
      );
      req.session.flash_error(req.t('settings.messages.carryOverFailed', {
        incidentId: logMarker
      }));
    })
    .finally(() => res.redirect_with_session('/settings/general/'));
});

router.post('/schedule/', function(req, res){

  var company, schedule, user,
      model = req.app.get('db_model');
  const isUserSpecificRequest = !!req.body.user_id;

  req.user.getCompany()

    // Obtain scheduler object
    .then(function(c){
      company = c;

      if ( ! req.body.user_id) {
        // We are dealing with company wide schedule: easy
        return company.promise_schedule();
      }

      // Rest is attempt to fetch user specific schedule for given user
      return company.getUsers({
        where : {
          id : validator.trim( req.body.user_id ),
        }
      })
      .then(function(u){
        user = u.pop();

        if ( ! user) {
          throw new Error(
            "Failed to find user "+req.body.user_id+" for company "+company.id
          );
        }

        return user.promise_schedule_I_obey();
      })
      .then(function(sch){
        if (sch.is_user_specific()) {
          // User specific schedule exists in database
          return Promise.resolve(sch);
        }

        // No user specific schedule in database: create in memory default instance
        return model.Schedule
          .promise_to_build_default_for({ user_id : user.id });
      });
    })

    // Update schedule object
    .then(function(sch){
      schedule = sch;

      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        .forEach(function(day){ schedule.set(day, req.body[day]) });

      if (schedule.is_user_specific() && _.has(req.body, 'revoke_user_specific_schedule') ) {
        return schedule.destroy();
      } else {
        return schedule.save();
      }
    })

    // Action is successfully done
    .then(function(){
      req.session.flash_message(schedule.is_user_specific()
        ? req.t('schedule.messages.userSaved')
        : req.t('schedule.messages.companySaved')
      );
    })

    // Action failed
    .catch(function(error){
      console.error('An error occurred while saving schedule: ' + error);
      req.session.flash_error(isUserSpecificRequest
        ? req.t('schedule.messages.userSaveFailed')
        : req.t('schedule.messages.companySaveFailed')
      );

    })

    // Depending on context redirect user to particular page
    .finally(function(){
      res.redirect_with_session(isUserSpecificRequest
        ? (user ? '/users/edit/'+user.id+'/schedule/' : '/users/')
        : '/settings/general/'
      );
    });
});

router.post('/leavetypes', function(req, res){

  var model = req.app.get('db_model');

  req.user

    .get_company_with_all_leave_types()
    .then(function(company){
      const submittedNewName = validator.trim(req.body['name__new']);
      const desiredNames = company.leave_types.map(leaveType =>
        validator.trim(req.body['name__'+leaveType.id]) || leaveType.name
      );

      if (submittedNewName) {
        desiredNames.push(submittedNewName);
      }

      const duplicateName = findDuplicateLeaveTypeName(desiredNames);
      if (duplicateName) {
        const error = new Error(req.t(
          'settings.leaveTypes.validation.nameDuplicate',
          { name : duplicateName }
        ));
        error.user_message = error.message;
        throw error;
      }

      let newLeaveTypeAttributes = null;
      if (submittedNewName) {
        newLeaveTypeAttributes = get_and_validate_leave_type({
          req       : req,
          suffix    : 'new',
          item_name : 'New Leave Type'
        });
        newLeaveTypeAttributes.companyId = company.id;
      }

      const existingLeaveTypeUpdates = company.leave_types.map(leave_type => ({
        leave_type,
        attributes: get_and_validate_leave_type({
          req       : req,
          suffix    : leave_type.id,
          item_name : leave_type.name,
        }),
      }));

      // Only after every submitted row has passed validation do we begin any
      // database writes. This prevents an invalid later row from leaving
      // earlier leave types partially updated.
      return Promise.all([
        newLeaveTypeAttributes
          ? model.LeaveType.create(newLeaveTypeAttributes)
          : Promise.resolve(1),
      ].concat(
        existingLeaveTypeUpdates.map(({leave_type, attributes}) =>
          attributes
            ? leave_type.update(attributes)
            : Promise.resolve(1)
        )
      ));
    })
    .then(() => {
      req.session.flash_message(req.t('settings.messages.leaveTypesSaved'));
      return res.redirect_with_session('/settings/general/');
    })
    .catch(error => {
      console.error(
        'An error occurred when trying to edit Leave types by user '+req.user.id
        + ' : ' + error
      );

      if (error.hasOwnProperty('user_message')) {
        req.session.flash_error( error.user_message );
      } else {
        req.session.flash_error(req.t('settings.messages.leaveTypesUpdateFailed'));
      }

      return res.redirect_with_session('/settings/general/');
    });
});

router.post('/leavetypes/delete/:leave_type_id/', function(req, res){

    var leave_type_id = req.params['leave_type_id'];

    var model = req.app.get('db_model');

    if (!validator.isInt(leave_type_id)) {
        console.log(`User ${req.user.id} submitted non-int leave_type id [${leave_type_id}]`);

        req.session.flash_error(req.t('settings.messages.leaveTypeRemoveWrongParams'));

        return res.redirect_with_session('/settings/general/');
    }

    req.user.getCompany({
        include : [{
            model : model.LeaveType,
            as : 'leave_types',
            include : [{model: model.Leave, as: 'leaves'}],
        }],
        order : [[{model: model.LeaveType, as : 'leave_types'}, 'name' ]],
    })
    .then(function(company){
        var leave_type_to_remove = company.leave_types.find( lt => String(lt.id) === String(leave_type_id) );

        // Check if user specify valid department number
        if (! leave_type_to_remove) {

            req.session.flash_error(req.t('settings.messages.leaveTypeRemoveWrongParams'));

            throw new Error(
              'User '+req.user.id+' tried to remove non-existing leave type number'
              +leave_type_id+' out of '+company.leave_types.length
            );


        // Check if there exist leaves for current type and if so, do not remove it
        } else if (leave_type_to_remove.leaves.length > 0) {

            req.session.flash_error(req.t('settings.messages.leaveTypeInUse'));

            throw new Error('Failed to remove Leave type because it is in used.');
        }

        return leave_type_to_remove.destroy();
    })
    .then(function(){
        req.session.flash_message(req.t('settings.messages.leaveTypeRemoved'));
        return res.redirect_with_session('/settings/general/');
    })
    .catch(function(error){
        console.error(
            'An error occurred when trying to remove leave type by user' + req.user.id
            + ' : ' + error
        );

        req.session.flash_error(req.t('settings.messages.leaveTypeRemoveFailed'));

        return res.redirect_with_session('/settings/general/');
    });
});

router.get('/company/integration-api/', (req, res) => {
  res.locals.custom_java_script.push('/js/settings_integration_api.js');
  res.set('Cache-Control', 'no-store');

  const accessToken = req.session.integration_api_token_once || null;
  delete req.session.integration_api_token_once;

  req.user
    .getCompany()
    .then(company => res.render('settings_company_integration_api', {
      title: req.t('integrationApi.title'),
      company,
      accessToken,
    }));
});

router.get('/company/diagnostics/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const snapshot = await diagnostics.collect();
  const enabledFeatureRows = Object.keys(snapshot.enabledFeatures || {}).sort().map(name => ({
    name,
    enabled: !!snapshot.enabledFeatures[name],
  }));

  res.render('settings_company_diagnostics', {
    title: req.t('diagnostics.title'),
    diagnostics: snapshot,
    enabledFeatureRows,
    diagnosticsJson: JSON.stringify(snapshot, null, 2),
  });
});

router.get('/company/diagnostics.json', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const snapshot = await diagnostics.collect();
  res.setHeader('Content-Disposition', 'attachment; filename="leavepilot-diagnostics.json"');
  res.type('application/json');
  res.send(JSON.stringify(snapshot, null, 2));
});

router.post('/company/integration-api/', (req, res) => {
  const featureIsEnabled = validator.toBoolean(req.body.integration_api_enabled);

  let action = req.user.getCompany();

  action = action.then(company => {
    company.set('integration_api_enabled', featureIsEnabled);
    return company.save();
  });

  if (req.body.regenerate_token) {
    action = action.then(company => company.regenerateIntegrationApiToken())
      .then(result => {
        req.session.integration_api_token_once = result.token;
        return result.company;
      });
  }

  action = action.then(() => {
    req.session.flash_message(req.t('settings.messages.saved'));

    return res.redirect_with_session('./');
  });

  action = action.catch(error => {
    console.log(`Failed to save Integration API configuration, reason: ${ extractSystemErrorMessage(error) }`);

    req.session.flash_error(req.t('settings.messages.saveFailed', {
      reason: extractUserErrorMessage(error)
    }));

    return res.redirect_with_session('./');
  })
});

router.get('/company/authentication/', function(req, res){

  req.user
    .getCompany()
    .then(function(company){
      return renderAuthenticationSettingsPage({
        req,
        res,
        company,
      });
    });
});

router.post('/company/authentication/', function(req, res){

  let ldapParameters;
  let ssoParameters;
  let company;
  const ssoAvailable = features.isEnabled('sso_authentication');

  req.user
    .getCompany()
    .then(function(foundCompany){
      company = foundCompany;

      ldapParameters = authSettings.getAndValidateLdapAuthConfiguration({
        req : req,
      });
      ssoParameters = ssoAvailable
        ? authSettings.getAndValidateSsoAuthConfiguration({ req : req })
        : {
          sso_auth_enabled: company.sso_auth_enabled,
          sso_auth_provider: company.sso_auth_provider,
          sso_auth_config: company.get('sso_auth_config') || {},
        };

      if (ldapParameters.ldap_auth_enabled && ssoParameters.sso_auth_enabled) {
        const error = new Error(req.t('settings.messages.authMutuallyExclusive'));
        error.show_to_user = true;
        throw error;
      }

      company.set('ldap_auth_config', ldapParameters.ldap_config);
      company.setDataValue('ldap_auth_enabled', ldapParameters.ldap_auth_enabled);
      if (ssoAvailable) {
        // The client secret is never pre-filled in the UI, so a blank submission
        // means "keep the current secret" rather than "clear it".
        if (!ssoParameters.sso_auth_config.client_secret) {
          const existingSsoConfig = company.get('sso_auth_config') || {};
          if (existingSsoConfig.client_secret) {
            ssoParameters.sso_auth_config.client_secret = existingSsoConfig.client_secret;
          }
        }
        company.set('sso_auth_config', ssoParameters.sso_auth_config);
        company.setDataValue('sso_auth_enabled', ssoParameters.sso_auth_enabled);
        company.setDataValue('sso_auth_provider', ssoParameters.sso_auth_provider);
      }

      if (ldapParameters.ldap_auth_enabled) {
        var ldap_server = company.get_ldap_server();
        var ldapError = '';

        ldap_server.on('error', function(err) {
          ldapError = err;
        });

        return new Promise(function(resolve, reject) {
          setTimeout(() => {
            if (ldapError) {
              reject(ldapError);
            }
          }, 1000);

          ldap_server.authenticate(req.user.email, ldapParameters.password_to_check, function(error, user) {
            if (error) {
              reject(error);
            } else {
              resolve(user);
            }
          });
        })
        .then(function(){
          return company.save();
        })
        .catch(function(error){
          console.error(
            'Failed to validate new LDAP settings with the current administrator credentials: '
            + error
          );
          const safeError = new Error(req.t('settings.messages.ldapValidationFailed'));
          safeError.show_to_user = true;
          throw safeError;
        });
      }

      if (ssoAvailable && ssoParameters.sso_auth_enabled) {
        return ssoService.validateSsoSettings(company)
          .then(function(){
            return company.save();
          });
      }

      return company.save();
    })

    .then(function(){
      if ( req.session.flash_has_errors() ) {
        return res.redirect_with_session('/settings/company/authentication/');
      }

      if (ldapParameters.ldap_auth_enabled) {
        req.session.flash_message(req.t('settings.messages.ldapUpdated'));
      } else if (ssoParameters.sso_auth_enabled) {
        req.session.flash_message(req.t('settings.messages.ssoUpdated'));
      } else {
        req.session.flash_message(req.t('settings.messages.authUpdated'));
      }

      return res.redirect_with_session('/settings/company/authentication/');
    })
    .catch(function(error){
      console.error(
        'An error occured while trying to update authentication configuration: %s', error
      );

      req.session.flash_error(req.t('settings.messages.authUpdateFailed', {
        reason: error.show_to_user ? error : req.t('settings.messages.contactSupport')
      }));

      if (company) {
        return renderAuthenticationSettingsPage({
          req,
          res,
          company,
          ssoService,
          useSubmittedValues: true,
          statusCode: 422,
        });
      }

      return res.redirect_with_session('/settings/company/authentication/');
    });
});

function renderAuthenticationSettingsPage(args) {
  return authSettings.renderAuthenticationSettingsPage(Object.assign({
    ssoService,
    ssoAvailable: features.isEnabled('sso_authentication'),
  }, args));
}

function getAuthenticationSettingsFormData(args) {
  return authSettings.getAuthenticationSettingsFormData(Object.assign({
    ssoService,
  }, args));
}

function getSubmittedAuthenticationFormValues(req) {
  return authSettings.getSubmittedAuthenticationFormValues(req);
}

function get_and_validate_leave_type(args) {
  let
    req       = args.req,
    suffix    = args.suffix,
    item_name = args.item_name;

  // Get user parameters
  let
    name          = validator.trim(req.body['name__'+suffix]),
    color        = validator.trim(req.body['color__'+suffix]) || 'leave_type_color_1',
    limit        = validator.trim(req.body['limit__'+suffix]) || 0,
    minimum_consecutive_days = validator.trim(req.body['minimum_consecutive_days__'+suffix]) || 0,
    deduction_unit = validator.trim(req.body['deduction_unit__'+suffix]) || 'working_days',
    first_record = validator.trim(req.body['first_record'])   || 0,
    use_allowance = validator.toBoolean(
      req.body['use_allowance__'+suffix]
    ),
    auto_approve = validator.toBoolean(
      req.body['auto_approve__'+suffix]
    );

  // If no name for leave type was provided: do nothing - treat case
  // as no need to update the leave type
  if ( ! name ) {
    return false;
  }

  // VPP TODO move that into resusable component
  let throw_user_error = function(key, options = {}){
    let error = new Error(req.t(key, options));
    error.user_message = error.message;
    throw error;
  };

  // Validate provided parameters
  if ( ! validator.matches(color, /^leave_type_color_\d+$/)) {
    throw_user_error('settings.leaveTypes.validation.colorInvalid', { name: item_name });
  }

  if ( ! validator.isNumeric(limit) ){
    throw_user_error('settings.leaveTypes.validation.limitInvalid', { name: item_name });

  } else if ( limit < 0) {
    throw_user_error('settings.leaveTypes.validation.limitNonNegative', { name: item_name });
  }

  if ( ! validator.isNumeric(minimum_consecutive_days) ){
    throw_user_error('settings.leaveTypes.validation.minimumInvalid', { name: item_name });

  } else if ( minimum_consecutive_days < 0) {
    throw_user_error('settings.leaveTypes.validation.minimumNonNegative', { name: item_name });
  }

  if (['working_days', 'calendar_days'].indexOf(deduction_unit) === -1) {
    throw_user_error('settings.leaveTypes.validation.deductionUnitInvalid', { name: item_name });
  }

  return {
    name          : name,
    color         : color,
    use_allowance : use_allowance,
    auto_approve  : auto_approve,
    limit         : limit,
    minimum_consecutive_days : minimum_consecutive_days,
    deduction_unit : deduction_unit,
    sort_order    : ( (first_record && (String(first_record)===String(suffix))? 1 : 0) ),
  };
}

function get_and_validate_ldap_auth_configuration(args) {
  return authSettings.getAndValidateLdapAuthConfiguration(args);
}

function get_and_validate_sso_auth_configuration(args) {
  return authSettings.getAndValidateSsoAuthConfiguration(args);
}

router.get('/company/backup/', (req, res) => {
  const companyExporter = new CompanyExporter({
    dbSchema : req.app.get('db_model'),
  });

  let company;

  req.user
    .getCompany()
    .then(c => Promise.resolve(company = c))

    // Generate company summary
    .then(company => companyExporter.promiseCompanySummary({ company : company }))

    // Get CSV presentation of company summary
    .then(companySummary => companySummary.promise_as_csv_string())

    .then(csv_content => {

      res.attachment(
        company.name_for_machine()+'_backup.csv'
      );

      res.send(csv_content);
    })
    .catch(function(error){
      console.error(
        "An error occured while downloading company summary: %s, at %s", error, error.stack
      );

      req.session.flash_error(req.t('settings.messages.companySummaryFailed', {
        reason: error.show_to_user ? error : req.t('settings.messages.contactSupport')
      }));

      return res.redirect_with_session('/settings/general/');
    });
});

router.post('/company/delete/', (req, res) => {

  let company;

  req.user
    .getCompany()
    .then(c => Promise.resolve(company = c))
    .then(company => CompanyRemover.promiseToRemove({
      company     : company,
      byUser      : req.user,
      confirmName : req.body.confirm_name,
    }))
    .then(() => {
      req.session.flash_message(req.t('settings.messages.companyRemoved', {
        company: company.name
      }));

      return res.redirect_with_session('/');
    })
    .catch(error => {

      console.log(
        `Failed to remove company [${company ? company.id : 'unavailable'}] by user ${req.user.id}. `
        + `Reason: ${ Exception.extract_system_error_message(error) }, at ${error.stack}`
      );

      req.session.flash_error(req.t('settings.messages.companyRemoveFailed', {
        reason: Exception.extract_user_error_message(error)
      }));

      return res.redirect_with_session('/settings/general/');
    });
});

const getAvailableCarriedOverOptions = () => ([
  {days : 0, label : 'None'},
  ...[...Array(21).keys()].filter(i=>i>0).map(i=>({days:i, label:i})),
  {days: 1000, label: 'All'},
]);

module.exports = router;
