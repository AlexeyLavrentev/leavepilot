
"use strict"
const { Op } = require('sequelize');

const
  Joi       = require('joi'),
  dayjs    = require('../../util/date'),
  Exception = require('../../error'),
  {commentLeave} = require('../comment'),
  Models    = require('../db');

const
  schemaCreateNewLeave = Joi.object().required().keys({
    for_employee    : Joi.object().required(),
    of_type         : Joi.object().required(),
    with_parameters : Joi.object().required(),
    locale          : Joi.string().optional(),
  });

/*
 * Create new leave for provided parameters.
 * Returns promise that is resolved with newly created leave row
 * */
function createNewLeave(args){

  args = Joi.attempt(
    args,
    schemaCreateNewLeave,
    "Failed to validate arguments"
  );

  const
    employee          = args.for_employee,
    leave_type        = args.of_type,
    valide_attributes = args.with_parameters;

  const
    start_date = dayjs.utc(valide_attributes.from_date),
    end_date   = dayjs.utc(valide_attributes.to_date);

  // Check that start date is not bigger then end one
  if ( start_date.toDate() > end_date.toDate() ) {
    Exception.throwUserError({
      user_error   : "Start date is later than end date",
      system_error : `Failed to add new Leave for user ${ employee.id } `
        `because start date ${  start_date } happnned to be after end date ${ end_date }`,
    });
  }

  const comment = valide_attributes.reason,
    companyId = employee.companyId;

  // Make sure that booking to be created is not going to ovelap with
  // any existing bookings
  return Promise

    .then(() => employee.validate_overlapping(valide_attributes, args.locale))
    .then(() => assertCriticalOverlapLimit({
      employee,
      start_date,
      end_date,
      locale: args.locale,
    }))
    .then(() => {
      // Call premium leave validator if registered
      const registry = require('../../edition').getRegistry();
      const validator = registry && registry.getLeaveValidator ? registry.getLeaveValidator() : null;

      if (validator) {
        return validator.validate({
          employee,
          start_date,
          end_date,
          locale: args.locale,
        });
      }
      return Promise.resolve();
    })
    .then(() => employee.promise_boss())
    .then(main_supervisor => {

      const new_leave_status = Models.Leave.does_skip_approval(employee, leave_type)
        ? Models.Leave.status_approved()
        : Models.Leave.status_new();

      // Following statement creates in memory only leave object
      // it is not in database until .save() method is called
      return Promise.resolve(Models.Leave.build({
        userId           : employee.id,
        leaveTypeId      : leave_type.id,
        status           : new_leave_status,
        approverId       : main_supervisor.id,
        employee_comment : valide_attributes.reason,

        date_start     : start_date.format('YYYY-MM-DD'),
        date_end       : end_date.format('YYYY-MM-DD'),
        day_part_start : valide_attributes.from_date_part,
        day_part_end   : valide_attributes.to_date_part,
      }));
    })

    .then(leave_to_create => employee
      .validate_leave_fits_into_remaining_allowance({
        year       : start_date,
        leave_type : leave_type,
        leave      : leave_to_create,
      })
      .then(() => leave_to_create.save())
    )
    .then(leave => commentLeaveIfNeeded({leave,comment,companyId}).then(() => leave))
    .then(leave => Promise.resolve(leave));
}

const { i18next, initI18next } = require('../../i18n');
initI18next();

const assertCriticalOverlapLimit = async ({ employee, start_date, end_date, leave_id_to_exclude, locale }) => {
  const groups = await employee.getGroups({
    joinTableAttributes: ['is_critical'],
  });

  if (!groups || groups.length === 0) {
    return Promise.resolve();
  }

  for (const group of groups) {
    if (!group.max_critical_overlap) {
      continue;
    }

    if (!group.UserGroup || !group.UserGroup.is_critical) {
      continue;
    }

    const critical_users = await group.getUsers({
      through: { where: { is_critical: true } },
      attributes: ['id'],
      joinTableAttributes: [],
    });

    if (critical_users.length === 0) {
      continue;
    }

    const critical_ids = critical_users.map(user => user.id);

    const overlap_filter = {
      userId: critical_ids,
      status: [
        Models.Leave.status_approved(),
        Models.Leave.status_new(),
        Models.Leave.status_pended_revoke(),
      ],
      date_start: { [Op.lte]: end_date.format('YYYY-MM-DD') },
      date_end: { [Op.gte]: start_date.format('YYYY-MM-DD') },
    };

    if (leave_id_to_exclude) {
      overlap_filter.id = { [Op.ne]: leave_id_to_exclude };
    }

    const overlapping_leaves = await Models.Leave.findAll({ where: overlap_filter });
    const unique_users = new Set(overlapping_leaves.map(leave => leave.userId));

    if (unique_users.size >= group.max_critical_overlap) {
      const error = new Error('Critical overlap limit exceeded');
      error.user_message = i18next.t('errors.criticalOverlapExceeded', { lng: locale || 'en' });
      throw error;
    }
  }

  return Promise.resolve();
};

const commentLeaveIfNeeded = ({leave,comment, companyId}) => {
  return comment ? commentLeave({leave,comment,companyId}) : Promise.resolve();
};

/*
 * Forecast how a prospective (not yet persisted) leave would affect the
 * employee's allowance, without creating any record or running booking
 * validations. Used by the booking form to answer "if you book this, you will
 * have N days left".
 *
 * Resolves with:
 *   {
 *     uses_allowance : Boolean,   // does this leave type draw from allowance
 *     deducted       : Number,    // working days deducted for the start year
 *     available      : Number,    // days available before this leave
 *     remaining      : Number,    // days available after this leave
 *     would_exceed   : Boolean,   // remaining would drop below zero
 *     spans_years    : Boolean,   // leave crosses a calendar-year boundary
 *   }
 *
 * The figures are computed against the year of the start date, mirroring how
 * validate_leave_fits_into_remaining_allowance treats the common case.
 */
function forecastLeaveBalance({ employee, leave_type, parameters }) {

  const
    start_date = dayjs.utc(parameters.from_date),
    end_date   = dayjs.utc(parameters.to_date);

  if (start_date.toDate() > end_date.toDate()) {
    return Promise.reject(new Error('Start date is later than end date'));
  }

  const year = start_date.clone();

  // In-memory only leave; never saved. Mirrors the shape built in
  // createNewLeave so the deduction logic behaves identically.
  const candidate_leave = Models.Leave.build({
    userId         : employee.id,
    leaveTypeId    : leave_type.id,
    status         : Models.Leave.status_new(),
    date_start     : start_date.format('YYYY-MM-DD'),
    date_end       : end_date.format('YYYY-MM-DD'),
    day_part_start : parameters.from_date_part,
    day_part_end   : parameters.to_date_part,
  });

  // Populate the employee with the schedule / bank holidays the deduction
  // calculation relies on (same preparation as the allowance validator).
  return employee
    .reload_with_leave_details({ year : year.clone() })
    .then(reloaded => reloaded.reload_with_session_details())
    .then(reloaded => reloaded.company.reload_with_bank_holidays()
      .then(() => reloaded)
    )
    .then(reloaded => reloaded
      .promise_allowance({ year : year.clone() })
      .then(allowance_obj => ({
        reloaded,
        available : allowance_obj.number_of_days_available_in_allowance,
      }))
    )
    .then(({ reloaded, available }) => {
      const uses_allowance = !! leave_type.use_allowance;

      const deducted = uses_allowance
        ? candidate_leave.get_deducted_days_number({
            year       : year.format('YYYY'),
            user       : reloaded,
            leave_type : leave_type,
          })
        : 0;

      const remaining = available - deducted;

      return {
        uses_allowance,
        deducted,
        available,
        remaining,
        would_exceed : uses_allowance && remaining < 0,
        spans_years  : start_date.year() !== end_date.year(),
      };
    });
}

const normaliseId = value => value === null || typeof value === 'undefined'
  ? null
  : String(value);

const getUserDepartmentId = async user => {
  if (!user) {
    return null;
  }

  if (typeof user.DepartmentId !== 'undefined') {
    return user.DepartmentId;
  }

  if (typeof user.departmentId !== 'undefined') {
    return user.departmentId;
  }

  if (user.department && typeof user.department.id !== 'undefined') {
    return user.department.id;
  }

  if (typeof user.getDepartment === 'function') {
    const department = await user.getDepartment();
    return department ? department.id : null;
  }

  return null;
};

const leaveNotFoundError = ({actingUser, leaveId}) => {
  const error = new Error(
    `User [${actingUser.id}] tried to access unavailable leave [${leaveId}].`
  );
  error.statusCode = 404;
  return error;
};

const getLeaveForUserView = async ({actingUser, leaveId, dbModel}) => {

  const [leave] = await dbModel.Leave.findAll({
    where: {
      id: leaveId,
    },
    include: [{
      model: dbModel.User,
      as: 'user',
      where: {
        companyId: actingUser.companyId,
      }
    }],
  });

  if (!leave) {
    throw leaveNotFoundError({actingUser, leaveId});
  }

  const owner = await leave.getUser();
  if (!owner) {
    throw leaveNotFoundError({actingUser, leaveId});
  }

  const actingUserId = normaliseId(actingUser.id);
  const ownerId = normaliseId(owner.id);

  if (actingUserId !== null && actingUserId === ownerId) {
    return leave;
  }

  if (await actingUser.promise_can_view_all_absences()) {
    return leave;
  }

  const actingDepartmentId = normaliseId(await getUserDepartmentId(actingUser));
  const ownerDepartmentId = normaliseId(await getUserDepartmentId(owner));

  if (
    actingDepartmentId !== null
    && ownerDepartmentId !== null
    && actingDepartmentId === ownerDepartmentId
  ) {
    return leave;
  }

  if (ownerDepartmentId !== null) {
    const supervisedDepartments = await actingUser.promise_supervised_departments();
    const supervisesOwner = (supervisedDepartments || []).some(
      department => normaliseId(department.id) === ownerDepartmentId
    );

    if (supervisesOwner) {
      return leave;
    }
  }

  throw leaveNotFoundError({actingUser, leaveId});

};

const doesUserHasExtendedViewOfLeave = async ({user, leave}) => {
  if (user.companyId !== (await leave.getUser()).companyId) {
    throw new Error(`User [${user.id}] and leave [${leave.id}] do not share company.`);
  }

  let extendedView = await user.promise_can_view_all_absences();

  if (! extendedView) {
    const reports = await user.promise_supervised_users();

    if (reports.filter(u => `${u.id}` === `${leave.userId}`).length > 0) {
      extendedView = true;
    }
  }

  return extendedView;
};

module.exports = {
  createNewLeave,
  forecastLeaveBalance,
  assertCriticalOverlapLimit,
  doesUserHasExtendedViewOfLeave,
  getLeaveForUserView,
}
