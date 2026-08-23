"use strict";

const fs = require("fs");
const path = require("path");
const expect = require("chai").expect;

describe("Leave type settings errors", function() {
  it("does not add a generic failure after a specific validation error", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "../../../lib/route/settings.js"),
      "utf8"
    );
    expect(source).to.match(
      /if \(Object\.prototype\.hasOwnProperty\.call\(error, 'user_message'\)\) \{[\s\S]*?\} else \{[\s\S]*?leaveTypesUpdateFailed/
    );
  });

  it("awaits every existing leave-type update before redirecting", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "../../../lib/route/settings.js"),
      "utf8"
    );

    expect(source).to.match(
      /Promise\.all\(\[[\s\S]*?\]\.concat\([\s\S]*?existingLeaveTypeUpdates\.map/
    );
  });
});
