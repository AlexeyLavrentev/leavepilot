
"use strict";

var express   = require('express'),
    router    = express.Router(),
    log       = require('../logger'),
    Promise   = require('bluebird'),
    moment    = require('moment'),
    _         = require('underscore'),
    validator = require('../util/validator'),
    get_and_validate_leave_params = require('./validator/leave_request'),
    features                      = require('../features'),
    TeamView                      = require('../model/team_view'),
    EmailTransport                = require('../email');

const {createNewLeave, forecastLeaveBalance, getLeaveForUserView, doesUserHasExtendedViewOfLeave} = require('../model/leave');
const LeaveRequestParameters = require('../model/leave_request_parameters');
const { getMinimumLeaveRequirementStatus } = require('../model/leave/minimum_leave_requirement');
const { leaveIntoObject } = require('../model/Report');
const { getCommentsForLeave } = require('../model/comment');
const { sorter } = require('../util');
const teamViewCache = require('../cache/team_view_cache');

const TEAM_VIEW_CACHE_TTL_SECONDS = 30;

const hasFlashMessages = (res) => {
  const flash = res.locals && res.locals.flash;
  return !!(
    flash
    && (
      (Array.isArray(flash.errors) && flash.errors.length)
      || (Array.isArray(flash.messages) && flash.messages.length)
      || (Array.isArray(flash.warnings) && flash.warnings.length)
    )
  );
};

router.post('/bookleave/', function(req, res){

    Promise.join (
      req.user.promise_users_I_can_manage(),
      req.user.get_company_with_all_leave_types(),
      Promise.try( () => get_and_validate_leave_params({req})),
      (users, company, valid_attributes) => {

        // Make sure that indexes submitted map to existing objects
        const employee = users[valid_attributes.user] || req.user;
        const [leave_type] = company.leave_types
          .filter(lt => `${lt.id}` === `${valid_attributes.leave_type}`);

        if (!employee) {
          req.session.flash_error(req.t('leaveRequest.messages.invalidEmployee'));
          throw new Error( 'Got validation errors' );
        }

        if (!leave_type) {
          req.session.flash_error(req.t('leaveRequest.messages.invalidLeaveType'));
          throw new Error( 'Got validation errors' );
        }

        if (company.is_mode_readonly_holidays() ){
          req.session.flash_error(
            req.t('calendar.messages.companyLocked')
          );
          throw new Error('Company is in "Read-only holidays" mode');
        }

        return createNewLeave({
          for_employee    : employee,
          of_type         : leave_type,
          with_parameters : valid_attributes,
          locale          : req.language || 'en',
        });
      }
    )
    .then(leave => leave.reloadWithAssociates())
    .then(async leave => {
      const warningStatus = await getMinimumLeaveRequirementStatus({
        user      : leave.user,
        leaveType : leave.leave_type,
        year      : moment.utc(leave.date_start),
      });

      if (warningStatus) {
        req.session.flash_warning(
          req.t('leaveWarnings.missingMinimumBlock', {
            year      : warningStatus.year,
            days      : warningStatus.requiredDays,
            leaveType : leave.leave_type.name,
          })
        );
      }

      return leave;
    })
    .then(leave => {
      const edition = require('../edition');
      edition.dispatchLeaveEvent({type: 'submitted', leave});
      return (new EmailTransport()).promise_leave_request_emails({leave});
    })
    .then(async function(){
        await teamViewCache.bumpCompanyVersion(req.user.companyId);

        req.session.flash_message(req.t('calendar.messages.leaveAdded'));
        return res.redirect_with_session(
          req.body['redirect_back_to']
            ? req.body['redirect_back_to']
            : '../'
        );
    })

    .catch(function(error){
        log.error('leave request creation failed', {
            userId : req.user.id,
            err    : error.message,
        });
        req.session.flash_error(req.t('calendar.messages.leaveCreateFailed'));
        if (error.hasOwnProperty('user_message')) {
            req.session.flash_error(error.user_message);
        }
        return res.redirect_with_session(
          req.body['redirect_back_to']
            ? req.body['redirect_back_to']
            : '../'
        );
    });

});

// JSON endpoint backing the booking form's live balance forecast. Given the
// dates/type the employee is about to request, it answers how many days would
// be deducted and how many would remain — without creating any record or
// touching session flash. Returns { ok : Boolean, reason? , ...figures }.
router.post('/leave-balance-forecast/', function(req, res){

  const respond = (payload) => res.json(payload);

  Promise.join(
    req.user.promise_users_I_can_manage(),
    req.user.get_company_with_all_leave_types(),
    (users, company) => {

      const body           = req.body || {};
      const leave_type_id  = validator.trim(body['leave_type'] || '');
      const from_date_raw  = validator.trim(body['from_date'] || '');
      const to_date_raw    = validator.trim(body['to_date'] || '');
      const from_date_part = validator.trim(body['from_date_part'] || '1') || '1';
      const to_date_part   = validator.trim(body['to_date_part'] || '1') || '1';
      const user_index     = validator.trim(body['user'] || '');

      if (!validator.isNumeric(leave_type_id)) {
        return respond({ ok : false, reason : 'invalid_leave_type' });
      }

      const [leave_type] = company.leave_types
        .filter(lt => `${lt.id}` === `${leave_type_id}`);

      if (!leave_type) {
        return respond({ ok : false, reason : 'invalid_leave_type' });
      }

      if (!validator.matches(from_date_part, /^[123]$/)
        || !validator.matches(to_date_part, /^[123]$/)) {
        return respond({ ok : false, reason : 'invalid_day_part' });
      }

      let from_date;
      let to_date;
      try {
        from_date = req.user.company.normalise_date(from_date_raw);
        to_date   = req.user.company.normalise_date(to_date_raw);
        if (!validator.isDate(from_date) || !validator.isDate(to_date)) {
          throw new Error('Invalid date');
        }
      } catch (e) {
        return respond({ ok : false, reason : 'invalid_date' });
      }

      if (moment.utc(from_date).toDate() > moment.utc(to_date).toDate()) {
        return respond({ ok : false, reason : 'invalid_range' });
      }

      // The employee select posts an index into the managed-users list, exactly
      // as the booking form itself does.
      const employee = users[user_index] || req.user;

      const parameters = new LeaveRequestParameters({
        leave_type     : leave_type_id,
        from_date      : from_date,
        from_date_part : from_date_part,
        to_date        : to_date,
        to_date_part   : to_date_part,
        reason         : '',
      });

      return forecastLeaveBalance({ employee, leave_type, parameters })
        .then(result => respond(Object.assign({ ok : true }, result)));
    }
  )
  .catch(error => {
    log.error('leave balance forecast failed', { userId: req.user.id, err: error.message });
    return respond({ ok : false, reason : 'error' });
  });
});

router.get('/', function(req, res) {

  var current_year = validator.isNumeric(req.query['year'])
    ? moment.utc(req.query['year'], 'YYYY')
    : req.user.company.get_today();

  var show_full_year = validator.toBoolean(req.query['show_full_year']);

  Promise.join(
    req.user.promise_calendar({
      year           : current_year.clone(),
      show_full_year : show_full_year,
      locale         : req.language || 'en',
    }),
    req.user.get_company_with_all_leave_types(),
    req.user.reload_with_leave_details({ year : current_year }),
    req.user.promise_supervisors(),
    req.user.promise_allowance({ year : current_year }),
    function(calendar, company, user, supervisors, user_allowance){
      let
        full_leave_type_statistics = user.get_leave_statistics_by_types();

      res.render('calendar', {
        calendar : _.map(calendar, function(c){return c.as_for_template()}),
        company        : company,
        title          : req.t('titles.calendar'),
        current_user   : user,
        supervisors    : supervisors,
        previous_year  : moment.utc(current_year).add(-1,'year').format('YYYY'),
        current_year   : current_year.format('YYYY'),
        next_year      : moment.utc(current_year).add(1,'year').format('YYYY'),
        show_full_year : show_full_year,
        leave_type_statistics      : _.filter(full_leave_type_statistics, st => st.days_taken > 0),

        // User allowance object is simple object with attributes only
        user_allowance : user_allowance,
      });
    }
  );

});

router.get('/teamview/', async (req, res) => {
  const user = req.user;
  const company = user.company || await user.getCompany();
  const can_view_all_absences = await user.promise_can_view_all_absences();

  if (company.is_team_view_hidden && !can_view_all_absences) {
    return res.redirect_with_session('/');
  }

  const base_date = validator.isDate(req.query['date'])
    ? moment.utc(req.query['date'])
    : company.get_today();

  const employeeGroupsEnabled = features.isEnabled('employee_groups');
  const grouped_mode = getGroupedModeParameter(req);
  const currentDepartmentId = getDepartmentIdForTeamView(req);
  const currentGroupId = employeeGroupsEnabled ? getGroupIdForTeamView(req) : null;
  const months_count = getMonthsCountForTeamView(req);
  const normalized_base_date = moment.utc(base_date).startOf('month');
  let start_date = normalized_base_date.clone();
  let end_date = normalized_base_date.clone();
  const locale = req.language || 'en';
  const allowCache = !hasFlashMessages(res);

  if (months_count > 1) {
    end_date = start_date.clone().add(months_count - 1, 'months');

    if (end_date.year() !== start_date.year()) {
      end_date = start_date.clone().endOf('year');
      start_date = end_date.clone().subtract(months_count - 1, 'months').startOf('month');
    }
  }

  const team_view = months_count > 1
    ? new TeamView({ user, company, start_date, end_date })
    : new TeamView({ user, company, base_date: normalized_base_date });

  try {
    let cacheKey = null;
    if (allowCache) {
      const cacheVersion = await teamViewCache.getCompanyVersion(company.id);
      cacheKey = teamViewCache.buildKey({
        user_id: user.id,
        company_id: company.id,
        cache_version: cacheVersion,
        locale,
        grouped_mode,
        current_department_id: currentDepartmentId,
        current_group_id: currentGroupId,
        employee_groups_enabled: employeeGroupsEnabled,
        months_count,
        start_date: start_date.toISOString(),
        end_date: end_date.toISOString(),
      });
    }

    if (cacheKey) {
      const cachedHtml = await teamViewCache.getHtml(cacheKey);
      if (cachedHtml) {
        return res.send(cachedHtml);
      }
    }

    const [team_view_details, companyWithLeaveTypes] = await Promise.all([
      team_view.promise_team_view_details({
        department_id: currentDepartmentId,
        group_id: currentGroupId,
        include_groups: employeeGroupsEnabled,
      }),
      user.get_company_with_all_leave_types(),
    ]);

    // Enrich "team view details" with statistics as how many deducted days each employee spent current month
    const team_view_details_with_stat = await team_view.inject_statistics({
      team_view_details,
      leave_types: companyWithLeaveTypes.leave_types,
    });

    const {users_and_leaves, related_departments, current_department} = await team_view.restrainStatisticsForUser({
      user,
      team_view_details: team_view_details_with_stat,
      employee_groups_enabled: employeeGroupsEnabled,
    });

    const defaultDepartmentName = current_department
      ? current_department.name
      : req.t('teamView.allDepartments');

    const months = buildTeamViewMonths({
      users_and_leaves,
      start_date,
      end_date,
      grouped_mode,
      default_department_name: defaultDepartmentName,
    });

    const renderingContext = {
      title: req.t('teamView.title'),
      company: companyWithLeaveTypes,
      users_and_leaves,
      related_departments,
      current_department,
      related_groups: team_view_details.related_groups,
      current_group: team_view_details.current_group,
      team_view_full_width: true,
      base_date: start_date,
      start_date,
      end_date,
      months_count,
      deducted_period: months_count > 1
        ? `${start_date.format('MMM')} - ${end_date.format('MMM, YYYY')}`
        : start_date.format('MMMM, YYYY'),
      prev_date: moment.utc(start_date).add(-months_count, 'month'),
      next_date: moment.utc(start_date).add(months_count, 'month'),
      months,
      show_month_title: months_count > 1,
    };

    if (grouped_mode) {
      renderingContext.grouped_mode = true;
    }

    return res.render('team_view', renderingContext, (error, html) => {
      if (error) {
        log.error('team view render failed', { userId: user.id, err: error.message });
        return res.status(500).send(req.t('errors.teamViewRenderFailed'));
      }
      if (cacheKey) {
        teamViewCache.setHtml(cacheKey, html, TEAM_VIEW_CACHE_TTL_SECONDS);
      }
      return res.send(html);
    });
  }
  catch (error) {
    log.error('team view access failed', { userId: user.id, err: error.message });
    req.session.flash_error(req.t('calendar.messages.teamViewAccessFailed'));

    if (error.hasOwnProperty('user_message')) {
      req.session.flash_error(error.user_message);
    }

    return res.redirect_with_session('/');
  };
});

const getGroupedModeParameter = (req) => {
  /**
   * grouped_mode parameter is saved in the current session so user's
   * transition between different pages does not reset the value
   */
  let groupedMode = !! req.query['grouped_mode'];

  if (req.query['save_grouped_mode']) {
    req.session.teamViewGroupedMode = groupedMode
  } 

  // for cases when no grouped_mode parameter was supplied: used onf from session
  if (req.query['grouped_mode'] === undefined) {
    groupedMode = req.session.teamViewGroupedMode
  }

  return groupedMode
};

const getDepartmentIdForTeamView = (req) => {
  /**
   * department parameter is saved in the current session so user's
   * transition between different pages does not reset the value
   */
  let departmentId = validator.isNumeric(req.query['department'])
    ? req.query['department']
    : null;

  if (req.query['save_current_department']) {
    req.session.teamViewDepartmentId = departmentId
  } 

  // for cases when no grouped_mode parameter was supplied: used onf from session
  if (req.query['department'] === undefined) {
    departmentId = req.session.teamViewDepartmentId
  }

  return departmentId
}

const getGroupIdForTeamView = (req) => {
  let groupId = validator.isNumeric(req.query['group'])
    ? req.query['group']
    : null;

  if (req.query['save_current_group']) {
    req.session.teamViewGroupId = groupId;
  }

  if (req.query['group'] === undefined) {
    groupId = req.session.teamViewGroupId;
  }

  return groupId;
};

const getMonthsCountForTeamView = (req) => {
  const allowedMonths = new Set([1, 3, 6, 12]);
  let monthsCount = validator.isNumeric(req.query['months'])
    ? Number(req.query['months'])
    : null;

  if (!allowedMonths.has(monthsCount)) {
    monthsCount = null;
  }

  if (req.query['save_months']) {
    req.session.teamViewMonthsCount = monthsCount || 1;
  }

  if (req.query['months'] === undefined) {
    monthsCount = req.session.teamViewMonthsCount;
  }

  if (!allowedMonths.has(monthsCount)) {
    monthsCount = 1;
  }

  return monthsCount;
};

const groupUsersOnTeamViewByDepartments = (usersAndLeaves) => {
  const departmentsDict = usersAndLeaves.reduce(
    (acc, item) => ({ ...acc, [item.user.department.id]: { departmentName: item.user.department.name, users_and_leaves: [] } }),
    {}
  );

  usersAndLeaves.forEach(item => {
    departmentsDict[item.user.department.id].users_and_leaves.push(item);
  });

  return Object.values(departmentsDict).sort((a, b) => sorter(a.departmentName, b.departmentName));
};

const buildTeamViewMonths = ({
  users_and_leaves,
  start_date,
  end_date,
  grouped_mode,
  default_department_name,
}) => {
  const months = [];
  let cursor = moment.utc(start_date).startOf('month');
  const lastMonth = moment.utc(end_date).startOf('month');

  const monthBuckets = [];
  while (cursor.isSameOrBefore(lastMonth, 'month')) {
    monthBuckets.push({
      key: cursor.format('YYYY-MM'),
      start: cursor.clone().startOf('month'),
      end: cursor.clone().endOf('month'),
    });
    cursor = cursor.add(1, 'month');
  }

  const usersByMonth = monthBuckets.map(() => []);

  users_and_leaves.forEach(userNode => {
    const daysByMonthKey = {};

    userNode.days.forEach(day => {
      const dayMoment = moment.utc(day.moment);
      const monthKey = dayMoment.format('YYYY-MM');
      if (!daysByMonthKey[monthKey]) {
        daysByMonthKey[monthKey] = [];
      }
      daysByMonthKey[monthKey].push(day);
    });

    monthBuckets.forEach((monthBucket, idx) => {
      const days = daysByMonthKey[monthBucket.key] || [];
      usersByMonth[idx].push({
        ...userNode,
        days,
      });
    });
  });

  monthBuckets.forEach((monthBucket, idx) => {
    const monthUsers = usersByMonth[idx];
    const departments = grouped_mode
      ? groupUsersOnTeamViewByDepartments(monthUsers)
      : [{ departmentName: default_department_name, users_and_leaves: monthUsers }];

    const departmentsWithHeaders = departments.map(department => ({
      ...department,
      header_days: department.users_and_leaves.length
        ? department.users_and_leaves[0].days
        : [],
    }));

    months.push({
      start_date: monthBucket.start,
      end_date: monthBucket.end,
      departments: departmentsWithHeaders,
    });
  });

  return months;
};

router.get('/feeds/', async function(req, res){
  const user = req.user;
  const company = user.company || await user.getCompany();

  /*
    promise_feed_of_type creates the feed when there is not one, so asking for
    a team view feed issues a token. It used to be asked for unconditionally,
    including for people this company does not show the team view to - and the
    template has hidden that card behind keep_team_view_hidden all along, so
    the row was minted for a page that would not display it, and it outlived
    the setting being turned on.
  */
  const may_see_team_view = ! company.is_team_view_hidden
    || await user.promise_can_view_all_absences();

  const feeds = await user.getFeeds();

  const calendar_feed = await promise_feed_of_type({user, feeds, type : 'calendar'});
  const team_view_feed = may_see_team_view
    ? await promise_feed_of_type({user, feeds, type : 'teamview'})
    : null;

  // The page's own script, which used to be inline in the template.
  res.locals.custom_java_script.push('/js/feeds_list.js');

  res.render('feeds_list', {
    title           : req.t('titles.feeds'),
    calendar_feed   : calendar_feed,
    team_view_feed  : team_view_feed,
    current_host    : req.get('host'),
    current_protocol: req.protocol,
  });
});

router.post('/feeds/regenerate/', function(req, res){
  var model = req.app.get('db_model');

  req.user
    .getFeeds()
    .then(function(feeds){
      var the_feed = _.findWhere(feeds, { feed_token : req.body['token'] });

      if (the_feed) {

        return model.UserFeed.promise_new_feed({
          user : req.user,
          type : the_feed.type,
        });
      }

      return Promise.resolve();
    })
    .then(function(){
        req.session.flash_message(req.t('calendar.messages.feedRegenerated'));
        return res.redirect_with_session('/calendar/feeds/');
    });
});

// Fetch or create new feed feed provided types
function promise_feed_of_type(args) {
  var type = args.type,
      user = args.user,
      feeds= args.feeds,
      feed = _.findWhere(feeds, { type : type }),
      feed_promise;

  if (! feed) {
    feed_promise = user.sequelize.models.UserFeed.promise_new_feed({
      user : user,
      type : type,
    });
  } else {
    feed_promise = Promise.resolve( feed );
  }

  return feed_promise;
}

router.get('/leave-summary/:leaveId/', async (req, res) => {
  const actingUser = req.user;
  const leaveId = validator.trim(req.params['leaveId']);
  const dbModel = req.app.get('db_model');

  try {
    const leave = await getLeaveForUserView({actingUser, leaveId, dbModel});
    const extendedView = await doesUserHasExtendedViewOfLeave({user: actingUser, leave});
    if (extendedView) {
      const user = await leave.getUser();
      await user.promise_schedule_I_obey();
      const [extendedLeave] = await user.promise_my_leaves({ignore_year: true, filter: {id: leave.id}});
      const leaveDetails = leaveIntoObject(extendedLeave);
      const comments = await getCommentsForLeave({leave});

      leaveDetails.commentsString = comments.map(({comment}) => comment).join('<br>');

      return res.render('leave/popup_leave_details', {
        leave: leaveDetails,
        layout: false,
      });
    } else {
      // return res.send('Short');
      const leaveDetails = leaveIntoObject(leave);
      return res.render('leave/popup_leave_details', {
        leave: leaveDetails,
        layout: false,
        limitedView: true,
      });
    }
  } catch (error) {
    log.error('leave summary failed', { leaveId, err: error.message });
    return res
      .status(error.statusCode || 500)
      .send(req.t('errors.leaveDetailsFailed'));
  }
});

module.exports = router;
