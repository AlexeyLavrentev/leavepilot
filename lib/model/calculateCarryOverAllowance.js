
'use strict';

const
  dayjs = require('../util/date'),
  pMap = require('p-map').default;

const calculateCarryOverAllowance = ({users}) => {

  const
    yearFrom = dayjs.utc().add(-1, 'y').year(),
    yearTo = dayjs.utc().year();

  let flow = Promise.resolve(users);

  flow = flow.then(users => pMap(
    users,
    user => {
      let carryOver;
      return Promise.resolve(user.getCompany().then(c => carryOver = c.carry_over))
        .then(() => user.reload_with_leave_details({year:dayjs.utc(String(yearFrom), "YYYY")}))
        .then(user => user.promise_allowance({
          year: dayjs.utc(String(yearFrom), "YYYY"),
          now: dayjs.utc(String(yearFrom), "YYYY").endOf('year'),
          forceNow: true,
        }))
        .then(allowance => {

          const carried_over_allowance = (carryOver === 0)
            ? 0
            : Math.min(allowance.number_of_days_available_in_allowance, carryOver);

          return user.promise_to_update_carried_over_allowance({
            carried_over_allowance,
            year: yearTo,
          });
        })
        .then(() => console.log(`Carried over unused allowance ${yearFrom} -> ${yearTo} for user ${user.id}`));
    },
    {concurrency : 1}
  ));

  return flow;
};

module.exports = { calculateCarryOverAllowance };
