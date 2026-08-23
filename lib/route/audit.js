
"use strict";
const { Op } = require('sequelize');

const express = require('express'),
validator   = require('../util/validator'),
_           = require('underscore'),
dayjs      = require('../util/date'),
log        = require('../logger'),
router      = express.Router(),
Pager = require('./utils/pager')();

// Make sure that current user is authorized to deal with settings
router.all(/.*/, require('../middleware/ensure_user_is_admin'));

router.get(/email/, function(req, res){

  const raw_user_id = validator.trim(req.query.user_id),
  user_id = validator.toInt(raw_user_id);
  let start_date  = validator.trim(req.query.start_date),
  end_date    = validator.trim(req.query.end_date),
  page        = validator.toInt(req.query.page) || 1;
  const model       = req.app.get('db_model'),
  filter      = {
    company_id: req.user.companyId,
  };

  if (page < 1) {page = 1;}

  const items_per_page = Pager.items_per_page;

  if (start_date) {start_date = req.user.company.normalise_date( start_date );}
  if (end_date) {end_date = req.user.company.normalise_date( end_date );}

  if (
    (start_date && !validator.isDate(start_date))
    || (end_date && !validator.isDate(end_date))
    || (raw_user_id && !validator.isInt(raw_user_id))
    || (
      start_date
      && end_date
      && dayjs.utc(end_date).isBefore(dayjs.utc(start_date), 'day')
    )
  ) {
    req.session.flash_error(req.t('emailAudit.invalidFilters'));
    return res.redirect_with_session('/audit/email/');
  }

  // if there is a valid start date provided pass it to the filter
  if ( validator.isDate(start_date) ) {
    if (! Object.prototype.hasOwnProperty.call(filter, 'created_at')) {filter.created_at = {};}
    filter.created_at[Op.gte] = dayjs.utc(start_date).startOf('day').toDate();
  }

  // ... same for end date

  if ( validator.isDate(end_date) ) {
    if (! Object.prototype.hasOwnProperty.call(filter, 'created_at')) {filter.created_at = {};}
    filter.created_at[Op.lte] = dayjs.utc(end_date).endOf('day').toDate();
  }

  if ( validator.isInt(user_id) ) {
    filter.user_id = user_id;
  }

  const promise_emails = model.EmailAudit.findAndCountAll({
      where    : filter,

      limit : items_per_page,
      offset : items_per_page * (page - 1),
      order : [
        [ 'id', 'DESC']
      ],

      include : [{
        model : model.User,
        as    : 'user',
      }]
  });

  const promise_all_users = model.User.findAll({
    where : {
      companyId : req.user.companyId,
    },
    order : [
      ['lastname']
    ],
  });

  return Promise.all([
    promise_emails,
    promise_all_users,
  ]).then(function([email_result, all_users]){

      const filter =  {
        user_id    : user_id,
      };

      if (start_date) {
        filter.start_date = dayjs.utc(start_date).format(req.user.company.get_default_date_format());
      }

      if (end_date) {
        filter.end_date = dayjs.utc(end_date).format(req.user.company.get_default_date_format());
      }

      res.render('audit/emails', {
        title             : req.t('emailAudit.title'),
        audit_emails      : email_result.rows,
        all_users         : all_users,
        filter            : filter,
        show_reset_button : _.some([ user_id, start_date, end_date ]),
        pager             : Pager.get_pager_object({
          filter : filter,
          total_items_count : email_result.count,
          current_page : page,
        }),
      });

    }
  )
  .catch(error => {
    log.error(
      `Failed to load email audit for company [${req.user.companyId}]`, { err: error.message, stack: error.stack }
    );
    req.session.flash_error(req.t('emailAudit.loadFailed'));
    return res.redirect_with_session('/settings/');
  });
});


module.exports = router;
