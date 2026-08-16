'use strict';

/*
  Vendored JS integrity watchdog (QUAL-06, D-16) - a standing gate, not a
  one-time checksum.

  public/js/jquery.min.js and public/js/bootstrap.min.js ship to every
  browser session outside any package manager, so their integrity is pinned
  by sha256 sidecars beside the files:

  - the core-ci.yml security job runs `sha256sum -c` on both sidecars, so a
    byte that drifts from the committed checksum fails the build at install
    time;
  - this spec recomputes both hashes on every unit run, so drift fails the
    build even before CI - and it pins the vendored versions.

  The sidecars carry no comment lines because GNU sha256sum -c warns on
  non-checksum lines; the version pins therefore live in the CI step name
  and in the VENDORED table below.
*/

const crypto = require('crypto');
const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

const VENDORED = [
  {
    path: 'public/js/jquery.min.js',
    version: '1.11.2',
    banner: 'jQuery v1.11.2',
  },
  {
    path: 'public/js/bootstrap.min.js',
    version: '3.3.4',
    banner: 'Bootstrap v3.3.4',
  },
];

const SIDECAR_SUFFIX = '.sha256';

// The exact format `sha256sum -c` and `shasum -a 256 -c` consume verbatim:
// 64 lowercase hex characters, two spaces, the repo-relative target path.
// The trailing \s* keeps the pattern usable on raw file content (a final
// newline or CRLF must not fail an otherwise well-formed line).
const SIDECAR_LINE = /^([0-9a-f]{64})  (\S.*)\s*$/;

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function matchesPinnedChecksum(buffer, expectedHex) {
  return sha256Hex(buffer) === expectedHex;
}

function readSidecar(vendoredPath) {
  const sidecarPath = path.join(REPO_ROOT, vendoredPath + SIDECAR_SUFFIX);
  const content = fs.readFileSync(sidecarPath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim().length > 0);

  if (lines.length !== 1) {
    return {malformed: 'expected exactly one checksum line, found ' + lines.length};
  }

  const match = lines[0].match(SIDECAR_LINE);

  if (!match) {
    return {malformed: 'checksum line does not match "<hash>  <path>"'};
  }

  return {hash: match[1], target: match[2]};
}

function tamperedCopy(buffer) {
  const copy = Buffer.from(buffer);
  // Flip one byte in the middle of the payload: enough to change the digest
  // while staying the same length and file shape.
  const index = Math.floor(copy.length / 2);
  copy[index] = copy[index] === 0x41 ? 0x42 : 0x41;
  return copy;
}

describe('Vendored JS integrity (D-16)', function() {
  it('has a real surface to guard (sidecars exist and name their targets)', function() {
    expect(VENDORED.length).to.equal(2);

    VENDORED.forEach(vendored => {
      const sidecarPath = path.join(REPO_ROOT, vendored.path + SIDECAR_SUFFIX);

      expect(fs.existsSync(sidecarPath), sidecarPath + ' must exist').to.equal(true);

      const parsed = readSidecar(vendored.path);
      expect(parsed.malformed, vendored.path + ' sidecar format').to.equal(undefined);
      expect(parsed.target, vendored.path + ' sidecar must name its target')
        .to.equal(vendored.path);
      expect(fs.existsSync(path.join(REPO_ROOT, vendored.path))).to.equal(true);
    });
  });

  it('the committed vendored bytes match the pinned checksums', function() {
    VENDORED.forEach(vendored => {
      const parsed = readSidecar(vendored.path);
      const actual = fs.readFileSync(path.join(REPO_ROOT, vendored.path));

      expect(
        matchesPinnedChecksum(actual, parsed.hash),
        vendored.path + ' drifted from ' + vendored.path + SIDECAR_SUFFIX
          + ' - restore the file or regenerate the sidecar deliberately'
      ).to.equal(true);
    });
  });

  it('the vendored banners match the pinned versions', function() {
    VENDORED.forEach(vendored => {
      const head = fs.readFileSync(path.join(REPO_ROOT, vendored.path))
        .slice(0, 300)
        .toString('utf8');

      expect(
        head,
        vendored.path + ' banner must pin ' + vendored.banner
          + ' - if the library was upgraded, regenerate the sidecar and update the pin'
      ).to.contain(vendored.banner);
    });
  });

  it('teeth: a tampered byte changes the digest and the comparator rejects it', function() {
    VENDORED.forEach(vendored => {
      const parsed = readSidecar(vendored.path);
      const pristine = fs.readFileSync(path.join(REPO_ROOT, vendored.path));
      const tampered = tamperedCopy(pristine);

      expect(tampered.length).to.equal(pristine.length);
      expect(tampered.equals(pristine), 'tamper must change the buffer').to.equal(false);

      const tamperedHex = sha256Hex(tampered);

      expect(tamperedHex, 'one flipped byte must move the digest').to.not.equal(parsed.hash);
      expect(matchesPinnedChecksum(tampered, parsed.hash)).to.equal(false);
      expect(matchesPinnedChecksum(pristine, parsed.hash)).to.equal(true);
    });
  });

  it('teeth: the sidecar parser accepts only the strict sha256sum format', function() {
    // Synthetic lines: the strictness of SIDECAR_LINE is proven without
    // touching the committed files.
    expect('# jQuery v1.11.2\n'.match(SIDECAR_LINE)).to.equal(null, 'comment lines are rejected');
    expect('deadbeef  public/js/jquery.min.js\n'.match(SIDECAR_LINE)).to.equal(null, 'short hashes are rejected');
    expect(
      '2ecd295d295bec062cedebe177e54b9d6b19fc0a841dc5c178c654c9ccff09c0 public/js/jquery.min.js\n'
        .match(SIDECAR_LINE)
    ).to.equal(null, 'single-space separator is not the sha256sum format');
    expect(
      '2ecd295d295bec062cedebe177e54b9d6b19fc0a841dc5c178c654c9ccff09c0\tpublic/js/jquery.min.js\n'
        .match(SIDECAR_LINE)
    ).to.equal(null, 'tab separator is not the sha256sum format');

    const match = (
      '2ecd295d295bec062cedebe177e54b9d6b19fc0a841dc5c178c654c9ccff09c0'
      + '  public/js/jquery.min.js\n'
    ).match(SIDECAR_LINE);

    expect(match[1]).to.equal('2ecd295d295bec062cedebe177e54b9d6b19fc0a841dc5c178c654c9ccff09c0');
    expect(match[2]).to.equal('public/js/jquery.min.js');
  });
});
