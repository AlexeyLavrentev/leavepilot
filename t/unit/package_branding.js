'use strict';

const {expect} = require('chai');
const fs = require('fs');
const path = require('path');
const packageJson = require('../../package.json');
const packageLock = require('../../package-lock.json');
const branding = require('../../lib/branding');

const root = path.join(__dirname, '..', '..');

// Mirrors the read() helper in t/unit/license_consistency.js so the
// doc/identity assertions below read the same files the licence watchdog does.
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Package branding', function() {
  it('uses the LeavePilot Community package name everywhere', function() {
    expect(packageJson.name).to.equal('leavepilot-community');
    expect(packageLock.name).to.equal('leavepilot-community');
    expect(packageLock.packages[''].name).to.equal('leavepilot-community');
  });
});

describe('Package and image identity contract', function() {

  it('points the community Dockerfile OCI source label at the new repo slug', function() {
    // D-10: the canonical repo URL is published here. A stale label would
    // mislead provenance scanners (threat T-02-06b).
    expect(read('Dockerfile')).to.include(
      'org.opencontainers.image.source="https://github.com/AlexeyLavrentev/leavepilot"'
    );
  });

  it('keeps the Elastic-2.0 licence label on the community Dockerfile', function() {
    // Cross-check alongside the source-slug change so a Dockerfile edit cannot
    // regress the licence claim while updating the slug. license_consistency.js
    // asserts the same label independently.
    expect(read('Dockerfile')).to.include(
      'org.opencontainers.image.licenses="Elastic-2.0"'
    );
  });

  it('leaves Dockerfile.portal without an OCI source label (documented D-10 no-op)', function() {
    // D-10 conditions the portal-label update on "if there is a label". There
    // is none today, so the decision is no-op. Pinning the absence makes a
    // future contributor adding one a deliberate change, not silent drift.
    expect(read('Dockerfile.portal')).to.not.match(/org\.opencontainers\.image\.source/);
  });

  it('states the container tag-support policy in docs/container-images.md', function() {
    const doc = read('docs/container-images.md');
    expect(doc, 'docs/container-images.md should state the tag-support policy (D-11)').to.include('Tag support policy');
    expect(doc).to.include('indefinitely');
  });

  it('points the cosign identity regex in docs/container-images.md at the new slug', function() {
    // Threat T-02-06a: the regex is what operators use to verify image
    // attestation provenance; it must point at the renamed repo or verification
    // against its attestations fails with a false negative.
    const doc = read('docs/container-images.md');
    expect(doc).to.include('AlexeyLavrentev/leavepilot');
    expect(doc, 'the old repo slug must not remain in docs/container-images.md').to.not.include('AlexeyLavrentev/timeoff');
  });

  it('documents the branding.get() Contract section', function() {
    expect(read('docs/features-branding.md')).to.include('## Contract');
  });

  it('documents every stable branding.get() field in the Contract section', function() {
    // The Contract section is a stable downstream-facing surface (D-13/D-14).
    // Pull the field list from lib/branding.js get() at test time so a field
    // added to get() WITHOUT a doc update fails this test — the contract and
    // the code stay in lockstep. Removing/renaming a field is a breaking major
    // change (D-14), so the documented set must always cover the code set.
    const doc = read('docs/features-branding.md');
    const contractSection = extractSection(doc, 'Contract');
    expect(contractSection, 'docs/features-branding.md must have a ## Contract section').to.be.a('string').that.is.not.empty;

    const expectedFields = Object.keys(branding.get());
    expect(expectedFields, 'branding.get() should return the contracted field set').to.not.be.empty;

    expectedFields.forEach(function(field) {
      expect(
        contractSection,
        'the Contract section must document the "' + field + '" field returned by branding.get()'
      ).to.include(field);
    });
  });

  it('documents the name/space split (Leave Pilot vs LeavePilot)', function() {
    const doc = read('docs/features-branding.md');
    const nameSection = extractSection(doc, 'Name and spacing');
    expect(nameSection, 'docs/features-branding.md must have a ## Name and spacing section').to.be.a('string').that.is.not.empty;
    expect(nameSection, 'the human-readable title spelling "Leave Pilot" (with space) must appear').to.include('Leave Pilot');
    expect(nameSection, 'the brand-token spelling "LeavePilot" (no space) must appear').to.include('LeavePilot');
  });
});

// Mirror license_consistency.js heading-block extraction (around L390/L520):
// find the heading whose text matches `name`, return the slice from that
// heading up to the next heading of any level (or end of document).
function extractSection(doc, name) {
  const lines = String(doc).split('\n');
  const start = lines.findIndex(function(line) {
    return /^#+\s/.test(line) && isHeadingName(line, name);
  });
  if (start === -1) {
    return '';
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#+\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

// Match a heading line like "## Contract" or "### Name and spacing" for the
// given section name, followed by whitespace or end-of-line (so "Contract"
// does not match "Contractual", and exact section boundaries are honoured).
function isHeadingName(headingLine, name) {
  return new RegExp('#+\\s+' + escapeRegexp(name) + '(\\s|$)').test(headingLine);
}

function escapeRegexp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
