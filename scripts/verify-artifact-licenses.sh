#!/usr/bin/env bash
#
# Prove that the licence files sitting in the repository root really travel
# inside a built image — byte for byte, as the running application sees them.
#
# Why this exists. The MIT licence inherited from the upstream fork requires its
# permission notice to be included in "all copies"; the Elastic License 2.0
# requires that anyone who gets a copy of the software also gets a copy of its
# terms. A container image is a copy. A COPY line in the Dockerfile is not proof
# that the copy arrived: a stale layer from the build cache can shadow the file,
# and a later layer can overwrite it. So this gate reads the files by running the
# image and compares their sha256 against the repository originals. It checks
# that the bytes match, not merely that a file exists, and it exits non-zero when
# a file is missing or out of date.
#
# Usage: scripts/verify-artifact-licenses.sh <image-ref> [app-dir]
#        app-dir defaults to /app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

usage() {
  echo "Usage: scripts/verify-artifact-licenses.sh <image-ref> [app-dir]" >&2
  echo "       app-dir defaults to /app" >&2
}

if [ "$#" -lt 1 ]; then
  echo "ERROR: an image reference is required." >&2
  usage
  exit 1
fi

IMAGE="$1"
APP_DIR="${2:-/app}"

# Deliberately a fixed list, not a glob: the gate must fail when a required file
# disappears, and a dynamic list would simply shrink with it.
LICENCE_FILES=("LICENSE.md" "NOTICE")

# The same hashing code runs on the host and inside the container, so the
# shasum/sha256sum difference between macOS and Linux never enters the picture.
HASH_SCRIPT='
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(1);
const baseDir = args[0];
const names = args.slice(1);
const result = {};
for (const name of names) {
  const target = path.join(baseDir, name);
  result[name] = fs.existsSync(target)
    ? crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")
    : null;
}
process.stdout.write(JSON.stringify(result));
'

json_get() {
  node -e 'const o = JSON.parse(process.argv[1]); const v = o[process.argv[2]]; process.stdout.write(v == null ? "" : String(v));' "$1" "$2"
}

HOST_JSON="$(node -e "$HASH_SCRIPT" "$PROJECT_DIR" "${LICENCE_FILES[@]}")"

# --network none and no bind mounts: reading two files needs no network and no
# host filesystem, and withholding both removes a whole class of surprises from
# the image's own CMD/ENTRYPOINT. --entrypoint node replaces the image entrypoint
# so the application itself never starts.
if ! IMAGE_JSON="$(docker run --rm --network none --entrypoint node "$IMAGE" -e "$HASH_SCRIPT" "$APP_DIR" "${LICENCE_FILES[@]}")"; then
  echo "FAIL could not read $APP_DIR in image $IMAGE" >&2
  exit 1
fi

# No early exit on the first failure: a report covering every file is more useful
# than the first thing that broke.
status=0

for name in "${LICENCE_FILES[@]}"; do
  host_hash="$(json_get "$HOST_JSON" "$name")"
  image_hash="$(json_get "$IMAGE_JSON" "$name")"

  if [ -z "$host_hash" ]; then
    echo "FAIL $name is missing from the repository root $PROJECT_DIR — there is nothing to compare against" >&2
    status=1
    continue
  fi

  if [ -z "$image_hash" ]; then
    echo "FAIL $name is missing from $APP_DIR in image $IMAGE (repository sha256 $host_hash)" >&2
    status=1
    continue
  fi

  if [ "$host_hash" != "$image_hash" ]; then
    echo "FAIL $name in $APP_DIR of image $IMAGE is a stale copy: image sha256 $image_hash, repository sha256 $host_hash" >&2
    status=1
    continue
  fi

  echo "OK $name $host_hash"
done

exit "$status"
