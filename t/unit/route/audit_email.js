"use strict";

const expect = require("chai").expect;
const router = require("../../../lib/route/audit");

function getHandler() {
  const layer = router.stack.find(item =>
    item.route
    && item.route.methods.get
  );
  return layer.route.stack[0].handle;
}

describe("Email audit route", function() {
  it("rejects invalid filters before querying the database", function() {
    let dbLookups = 0;
    const errors = [];
    const req = {
      query: {
        start_date: "bad-date",
      },
      user: {
        companyId: 4,
        company: {
          normalise_date(value) {
            return value;
          },
        },
      },
      t(key) {
        return key;
      },
      session: {
        flash_error(message) {
          errors.push(message);
        },
      },
      app: {
        get() {
          dbLookups += 1;
          return {};
        },
      },
    };
    const res = {
      redirect_with_session(location) {
        expect(location).to.equal("/audit/email/");
      },
    };

    getHandler()(req, res);

    expect(dbLookups).to.equal(1);
    expect(errors).to.deep.equal(["emailAudit.invalidFilters"]);
  });

  it("uses inclusive day boundaries for date filters", function() {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "../../../lib/route/audit.js"),
      "utf8"
    );

    expect(source).to.contain("dayjs.utc(start_date).startOf('day').toDate()");
    expect(source).to.contain("dayjs.utc(end_date).endOf('day').toDate()");
  });
});
