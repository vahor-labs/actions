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

Use `pull_request`, never `pull_request_target`. Set `preview-url`:

```yaml
with:
  preview-url: https://my-app-${{ github.event.pull_request.number }}.preview.example.com
```

Your deployment system must:

1. Watch for `preview-ready` and deploy the exact PR image.
2. Bake the `APP_BUILD_SHA` build argument into the runtime image.
3. Serve this at `GET /deployment.json` with `Cache-Control: no-store`:

```json
{"sha":"<exact full PR head SHA>"}
```

## Preview comments

One bot comment tracks **Building** → **Deploying** → **Ready**.

Example (placeholder links, commit and timestamp):

| Deployment | Actions | Updated |
| :--- | :--- | :--- |
| ✅ [Ready](https://my-app-42.preview.example.com) | [Logs](https://github.com/example/my-app/actions/runs/123456789) · [`a1b2c3d`](https://github.com/example/my-app/commit/a1b2c3d4e5f67890123456789012345678901234) | 2026-11-01T12:00:00.000Z |

- **Ready:** HTTPS returns HTTP 200 with the exact full SHA.
- **Waiting:** checks every 15 seconds, for up to 15 minutes.
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
