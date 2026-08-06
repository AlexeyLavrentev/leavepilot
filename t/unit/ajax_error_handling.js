"use strict";

const fs = require("fs");
const path = require("path");
const expect = require("chai").expect;

describe("AJAX error handling", function() {
  it("shows a localized fallback instead of leaving summaries loading forever", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "../../public/js/global.js"),
      "utf8"
    );

    expect(source).to.contain("error: function()");
    expect(source).to.contain(".text(translations.requestFailed)");
  });

  it("exposes the localized request failure message to browser scripts", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "../../views/layouts/main.hbs"),
      "utf8"
    );

    // Rendered as data now, in a JSON block the browser parses rather than
    // executes, so that no page carries inline script.
    expect(source).to.contain('"requestFailed": {{{json (t "errors.requestFailed")}}}');
  });

  it("adds the session CSRF token to same-origin AJAX writes", function() {
    const script = fs.readFileSync(
      path.join(__dirname, "../../public/js/global.js"),
      "utf8"
    );
    const layout = fs.readFileSync(
      path.join(__dirname, "../../views/layouts/main.hbs"),
      "utf8"
    );

    expect(layout).to.contain('"csrfToken": {{{json csrf_token}}}');
    expect(script).to.contain("$(document).ajaxSend");
    expect(script).to.contain("X-CSRF-Token");
    expect(script).to.contain("input[name=\"_csrf\"]");
  });

  it("uses native validation and disables the activated single-click button", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "../../public/js/global.js"),
      "utf8"
    );

    expect(source).to.contain("var button = e.currentTarget");
    expect(source).to.contain("formElement.checkValidity()");
    expect(source).to.contain("$(button).prop('disabled', true)");
    expect(source).to.not.contain("$(e.target).prop('disabled', true)");
    expect(source).to.not.contain("formIsValid");
  });
});
