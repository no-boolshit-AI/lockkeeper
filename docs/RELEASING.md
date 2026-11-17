# Releasing Lockkeeper

A release is a version tag. Pushing it runs [the release workflow](../.github/workflows/release.yml), which checks the code again and then publishes three things, each signed through Sigstore with the workflow's own identity:

| Artefact | Where | Signed with |
| --- | --- | --- |
| npm package `lockkeeper` | npmjs.com | npm provenance |
| Container image | `ghcr.io/no-boolshit-ai/lockkeeper`, for linux/amd64 and linux/arm64 | cosign (keyless), plus an SBOM and build provenance |
| `lockkeeper-<version>.tgz` and `SHA256SUMS` | the GitHub release | a GitHub artefact attestation |

## Cutting a release

1. Set the version in `package.json`, such as `0.2.0` or `0.2.0-beta.1`, and run `npm install` so the lockfile matches.
2. Run `npm run check`, commit, and push to `main`. Wait for CI to pass.
3. Tag the commit and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

A version with a hyphen is a pre-release: npm gets it under the `next` tag, the image gets no `latest` tag, and the GitHub release is marked as a pre-release.

The tag must match `package.json`, or the workflow stops before publishing anything.

## One-time setup

- **npm.** Either configure [trusted publishing](https://docs.npmjs.com/trusted-publishers) for the package, with this repository and `release.yml` as the publisher, or add an automation token as the `NPM_TOKEN` secret. Trusted publishing needs no stored token and is preferred.
- **GitHub environment.** Create an environment called `release` and add required reviewers, so a pushed tag waits for a person before anything is published.
- **GHCR.** After the first release, make the `lockkeeper` package public in the organisation's package settings.

## Verifying a release

npm package:

```bash
npm install lockkeeper && npm audit signatures
```

Container image:

```bash
cosign verify ghcr.io/no-boolshit-ai/lockkeeper:0.2.0 \
  --certificate-identity-regexp '^https://github.com/no-boolshit-AI/lockkeeper/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Release files:

```bash
gh attestation verify lockkeeper-0.2.0.tgz --repo no-boolshit-AI/lockkeeper
sha256sum --check SHA256SUMS
```
