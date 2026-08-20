
"use strict";
const { Op } = require('sequelize');

const
  express  = require('express'),
  router   = express.Router(),
  _        = require('underscore'),
  moment   = require('moment'),
  pMap     = require('p-map'),
  log      = require('../logger'),
  ical     = require('ical-generator').default,
  config   = require('../config'),
  branding = require('../branding'),
  TeamView = require('../model/team_view');

const
  numberOfFutureMonthsInTeamViewFeed = config.get('number_of_future_months_in_team_view_feed') || 6,
  numberOfPastMonthsInTeamViewFeed   = config.get('number_of_past_months_in_team_view_feed') || 2;

const { getVisibleCommentsForFeed } = require('../model/feed_visibility');

router.get('/:token/ical.ics', function(req, res){

  var cal = ical(),
    token = req.params['token'],
    model = req.app.get('db_model'),
    user;

  // The iCal product identifier and the calendar name both flow from the
  // branding layer (BRAND-04, D-07), so a rebrand via BRAND_* changes the
  // feed without a code edit. PRODID renders as //-<brand name>-//-<shortName>-//EN;
  // X-WR-CALNAME carries "{brand}: {meaningful name}" so the calendar stays
  // readable in a subscriber's client. The brand values are flattened to a
  // single line before reaching ical-generator: ical-generator 11.1.0 does
  // not escape CR/LF in PRODID/X-WR-CALNAME, so an operator-controlled
  // multi-line BRAND_NAME would otherwise inject extra iCal property lines
  // into every subscriber's feed (WR-03, G-02-3).
  var brand = branding.get();
  var singleLine = function(v) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim(); };
  cal.prodId({ company: singleLine(brand.name), product: singleLine(brand.shortName), language: 'EN' });

  Promise
    .resolve()
    .then(() => model.UserFeed.findOne({
        where   : {feed_token : token},
        include : [{
          model : model.User,
          as    : 'user',
          include : [{
            model : model.Company,
            as    : 'company',
            where : {
              mode : {[Op.ne] : model.Company.get_mode_readonly_holidays()},
            },
          }]
        }]
      })
    )
    .then(async function(feed){

      if ( ! feed ) {
        const error = new Error("Unknown token provided");
        error.statusCode = 404;
        throw error;
      }

      user = feed.user;

      /*
        A company that hides the team view hides this too. /calendar/teamview/
        has always turned these people away; the feed carrying the same data
        did not, so a URL handed out before the setting was turned on went on
        reporting every colleague's absences for nine months either side of
        today, and there was no way to withdraw it.

        The same answer as an unknown token, on purpose: a distinct one would
        tell the holder that their token is still live.
      */
      if ( feed.is_team_view()
        && user.company.is_team_view_hidden
        && ! await user.promise_can_view_all_absences()
      ) {
        const error = new Error("Unknown token provided");
        error.statusCode = 404;
        throw error;
      }

      if (feed.is_calendar()){
        cal.name(singleLine(brand.name) + ': ' + user.full_name() + ' calendar');

        return user
          .promise_calendar({
            year           : user.company.get_today(),
            show_full_year : true,
          })
          .then(function(calendar){
            let days = _.flatten( calendar.map( cal => cal.as_for_team_view() ));

            days.forEach(day => day.user = user);

            return Promise.resolve(days);
          });
      } else {

        cal.name(`${ singleLine(brand.name) }: ${ user.full_name() }'s team whereabout`);

        // Get the list of month deltas in relation to current month, to we can calculate
        // moths for which to build the feed
        let monthDeltas = Array.from(Array(numberOfFutureMonthsInTeamViewFeed + 1).keys())
          .concat( Array.from(Array(numberOfPastMonthsInTeamViewFeed).keys()).map(i => -1 * (i + 1)) );

        return Promise.resolve(
            monthDeltas.map(
              delta => user.company.get_today().clone().add(delta, 'months').startOf('month')
            )
          )
          .then(months => pMap(months, month => {

            const team_view = new TeamView({
              user      : user,
              base_date : month,
            });

            return team_view.promise_team_view_details()
              .then(details => {
                let days = [];

                details.users_and_leaves.forEach(rec => {
                  rec.days.forEach(day => day.user = rec.user);
                  days = days.concat( rec.days );
                });

                return Promise.resolve(days);
              });
          }, { concurrency : 2 })
          .then(arrayOfDays => Promise.resolve( _.flatten(arrayOfDays) ));
      }
    })

    .then(async (days) => {
      for (const day of days) {
        // We care only about days when employee is on leave
        if (!(day.is_leave_morning || day.is_leave_afternoon)) {
          continue;
        }

        let start = moment.utc(day.moment),
            end = moment.utc(day.moment),
            allDay = false;

        if (day.is_leave_morning && day.is_leave_afternoon) {
          start.hour(9).minute(0);
          end.hour(17).minute(0);
          allDay = true;
        } else if (!day.is_leave_morning && day.is_leave_afternoon) {
          start.hour(13).minute(0);
          end.hour(17).minute(0);
        } else if (day.is_leave_morning && !day.is_leave_afternoon) {
          start.hour(9).minute(0);
          end.hour(13).minute(0);
        }

        const comments = await getVisibleCommentsForFeed({
          actingUser: user,
          leave: day.leave_obj,
        });

        cal.createEvent({
          start   : start.toDate(),
          end     : end.toDate(),
          allDay  : allDay,
          summary : day.user.full_name() + ' is OOO (out of office)',
          description: (comments.length > 0
            ? `With comments: ${comments.map(({comment}) => comment).join('. ')}`
            : ''
          ),
        });
      }

      res.type('text/calendar').send( cal.toString() );
    })
    .catch(error => {

      log.error('feed fetch failed', { err: error.message });

      res.status(error.statusCode || 500).send(req.t('errors.feedUnavailable'));
    });

});


module.exports = router;
