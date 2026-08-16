# LeavePilot container images

## Community image

The public multi-platform image is published to:

```text
ghcr.io/alexeylavrentev/leavepilot-community
```

Supported platforms:

- `linux/amd64`
- `linux/arm64`

Release tags include the full version, minor version, major version, `latest`,
and the source commit SHA. Production deployments should pin the full version:

```sh
export LEAVEPILOT_IMAGE=ghcr.io/alexeylavrentev/leavepilot-community:2.1.0
export SESSION_SECRET=replace-with-a-long-random-session-secret
export CRYPTO_SECRET=replace-with-a-long-random-crypto-secret

docker compose -f docker-compose.community-image.yml up -d
```

The standalone Compose file pulls the published image and does not require a
local source checkout to build the application.

## Tag support policy

Published tags remain pullable indefinitely: GHCR does not delete tags or
images, so every version tag (full, minor, major) ever published stays
available. The `latest` tag tracks the last stable release and moves on each
new release; it is convenient for evaluation but is not reproducible.
Production deployments should pin a full version tag (for example `2.1.0`) so
an image pull is byte-stable across hosts and over time.

## Publishing

The Community workflow runs automatically for new semantic version tags. An
existing tag can be published from GitHub Actions with **Run workflow** by
entering a tag such as `v2.1.0`.

The workflow:

1. verifies that the tag matches `package.json`;
2. builds `amd64` and `arm64` images in parallel on native GitHub-hosted runners;
3. publishes each platform by immutable digest;
4. checks the LeavePilot branding and Community/Premium boundary against the
   `amd64` digest;
5. combines both verified digests into the versioned multi-platform tags.
6. generates and attests an SPDX JSON SBOM for each platform digest;
7. signs each platform digest and the final manifest with keyless Cosign.

The first GHCR package is private by default. After its first successful
publication, change `leavepilot-community` visibility to **Public** in the
package settings.

After publishing, verify the manifest:

```sh
docker buildx imagetools inspect \
  ghcr.io/alexeylavrentev/leavepilot-community:2.1.0
```

The output must include both `linux/amd64` and `linux/arm64`.

Verify release identity and SBOM attestation with Cosign:

```sh
IMAGE=ghcr.io/alexeylavrentev/leavepilot-community:2.1.0
IDENTITY='^https://github.com/AlexeyLavrentev/leavepilot/.github/workflows/publish-community-container.yml@refs/(tags/v[0-9]+\.[0-9]+\.[0-9]+|heads/master)$'
ISSUER='https://token.actions.githubusercontent.com'

cosign verify "$IMAGE" \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER"

# Copy the required amd64 or arm64 digest from `imagetools inspect`.
PLATFORM_IMAGE=ghcr.io/alexeylavrentev/leavepilot-community@sha256:PLATFORM_DIGEST

cosign verify-attestation "$PLATFORM_IMAGE" \
  --type spdxjson \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER"
```

Always verify a versioned tag or immutable digest, never `latest`.

## Premium delivery

LeavePilot Premium is delivered as a separate private image. The license and
public verification key are runtime secrets and are never embedded into either
container image.
