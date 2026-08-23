'use strict';

/*
 * First-run helper: creates a company and its administrator account from
 * the command line, so operators do not have to temporarily enable public
 * registration to bootstrap an installation.
 *
 * Usage:
 *   npm run create-admin -- --email admin@example.com --company "My Company"
 *
 * Options:
 *   --email     (required) admin login email
 *   --company   (required) company name
 *   --password  admin password; a random one is generated and printed if omitted
 *   --country   ISO country code for the company (default: RU)
 *   --timezone  company timezone (default derived from country)
 *   --name      admin first name (default: Admin)
 *   --lastname  admin last name (default: Admin)
 */

const log = require('../lib/middleware/request_logger');

const argv = require('minimist')(process.argv.slice(2));
const crypto = require('crypto');
const validator = require('validator');

const models = require('../lib/model/db');

function fail(message) {
  log.error('create_admin_error', { message });
  log.error('create_admin_usage', {
    usage: 'npm run create-admin -- --email admin@example.com --company "My Company" [--password ...] [--country RU] [--timezone Europe/Moscow] [--name Admin] [--lastname Admin]',
  });
  process.exit(1);
}

const email = String(argv.email || '').trim().toLowerCase();
const companyName = String(argv.company || '').trim();
let password = argv.password ? String(argv.password) : null;
const countryCode = String(argv.country || 'RU').trim().toUpperCase();
const timezone = argv.timezone ? String(argv.timezone).trim() : undefined;
const firstName = String(argv.name || 'Admin').trim();
const lastName = String(argv.lastname || 'Admin').trim();

if (!email || !validator.isEmail(email)) {
  fail('--email is required and must be a valid email address');
}

if (!companyName) {
  fail('--company is required');
}

let generatedPassword = false;

if (!password) {
  // URL-safe, no ambiguous characters; 16 chars of base64url ≈ 96 bits
  password = crypto.randomBytes(12).toString('base64url');
  generatedPassword = true;
}

if (password.length < 8) {
  fail('--password must be at least 8 characters long');
}

models.connect()
  .then(function() {
    return models.User.register_new_admin_user({
      email        : email,
      password     : password,
      name         : firstName,
      lastname     : lastName,
      company_name : companyName,
      country_code : countryCode,
      timezone     : timezone,
      activated    : true,
    });
  })
  .then(function(user) {
    log.info('administrator_created', {
      company: companyName,
      email: user.email,
    });
    if (generatedPassword) {
      log.info('generated_password', { password });
      log.info('password_notice', { msg: 'This generated password is shown only once. Store it securely and change it after the first login.' });
    }
    log.info('signin_url', { url: '/login/' });
    return models.sequelize.close();
  })
  .catch(function(error) {
    log.error('create_admin_failed', {
      error: error && error.show_to_user ? error.message : (error && error.stack || String(error)),
    });
    return models.sequelize.close()
      .catch(function() {})
      .then(function() {
        process.exit(1);
      });
  });
