# actions

Reusable GitHub workflows for container builds and verified pull-request previews.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Quick start](#quick-start) · [Workflows](#workflows) · [Preview comments](#preview-comments) · [Contributing](CONTRIBUTING.md)

## Quick start

Add `.github/workflows/container-main.yml` to an application with a root Dockerfile:

```yaml
name: Build main container

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    permissions:
      contents: read
      packages: write
    uses: vahor-labs/actions/.github/workflows/main-build.yml@main
```

Publishes Linux AMD64 images to `ghcr.io/<owner>/<repository>` (lowercase).
Uses `GITHUB_TOKEN`; no deployment secrets needed.

## Workflows

| Workflow | Caller event | Required permissions |
| --- | --- | --- |
| [main-build.yml](.github/workflows/main-build.yml) | Push to `main` or manual dispatch | `contents: read`, `packages: write` |
| [pr-build.yml](.github/workflows/pr-build.yml) | PR opened, synchronized or reopened | `contents: read`, `packages: write`, `pull-requests: write` |
| [image-cleanup.yml](.github/workflows/image-cleanup.yml) | PR closed, schedule or manual dispatch | `contents: read`, `packages: write` |

### Image tags

- **Main:** `sha-<full SHA>`. Only the current head can update `main`.
- **Pull requests:** `pr-<number>-<full head SHA>`, built from the actual PR head.
- **Fork PRs:** build only. No publishing or PR updates.

Deploy by immutable digest, not the mutable `main` tag.

### Pull-request previews

Use `pull_request`, never `pull_request_target`. Preview URLs are generated under
`preview.vahor.fr` from the repository name: lowercase, non-alphanumeric runs
replaced with `-`, trimmed and limited to 46 characters. `vahor.fr` becomes
`vahor-fr`, so its caller needs no inputs. Override only when necessary:

```yaml
with:
  preview-prefix: my-app
```

The prefix must be a lowercase DNS label, at most 46 characters. The generated
URLs are `https://<prefix>-pr-<number>.preview.vahor.fr/` and
`https://<prefix>-sha-<first 12 head SHA characters>.preview.vahor.fr/`.
The action probes the commit URL itself, not an appended endpoint.

Your deployment system must:

1. Watch for `preview-ready` and deploy the exact PR image.
2. Route the stable PR hostname to the current preview.
3. Restrict the commit-specific route to pods selected by the **full head SHA**,
   not merely the 12-character hostname prefix or a shared PR selector. A missing
   or stale commit must not fall back to another revision, redirect to the stable
   route, or return an HTTP 200 default backend.
4. Retain only the current commit route for each PR; remove the old route when
   the PR head changes, and remove both routes when the PR closes.

Readiness means HTTP 200 from that isolated commit route, not an application
response containing a SHA. No application code, `deployment.json`, or PR
`APP_BUILD_SHA` build argument is required. Full-SHA verification depends on the
infrastructure routing contract above; the action cannot inspect pod selectors.
The main-image workflow still passes `APP_BUILD_SHA` for the existing production
endpoint.

## Preview comments

One bot comment tracks **Building** → **Deploying** → **Ready**.

Example (placeholder links, commit and timestamp):

| Deployment | Actions | Updated |
| :--- | :--- | :--- |
| ✅ Ready · [PR preview](https://my-app-pr-42.preview.vahor.fr/) · [Commit preview](https://my-app-sha-a1b2c3d4e5f6.preview.vahor.fr/) | [Logs](https://github.com/example/my-app/actions/runs/123456789) · [`a1b2c3d`](https://github.com/example/my-app/commit/a1b2c3d4e5f67890123456789012345678901234) | 2026-11-01T12:00:00.000Z |

- **Ready:** the HTTPS commit-specific URL returns HTTP 200 and the PR head is
  still current. The comment shows both PR and commit preview links.
- **Building / Deploying:** retain the stable PR link if already present in the
  bot comment. The commit link is shown only after readiness succeeds. The stable
  alias may be briefly unavailable while the single preview pod is replaced.
- **Waiting:** checks every 15 seconds, for up to 15 minutes, with no-cache
  requests and a maximum 10-second timeout per probe. Redirects are errors;
  non-200 responses, network failures and timeouts are retried within the deadline.
- **Failed or timed out:** no preview link. Rerun to check again.

## Image cleanup

Keep cleanup triggers in the calling repository:

- **PR closed:** delete versions used only by that PR.
- **Schedule or manual dispatch:** delete old, untagged versions.
  Set `older_than_hours` to a non-negative integer string (default `"24"`).

Shared versions are preserved. Builds never delete images.

## Contributing

[Contribution guide](CONTRIBUTING.md) · [Report a bug or request a feature](https://github.com/vahor-labs/actions/issues/new/choose)

## License

[MIT](LICENSE).
