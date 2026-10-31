# Shared GitHub Actions

Public reusable workflows for `vahor-labs` applications. Infrastructure
deployment configuration and credentials remain in `ansible-configs`.

## Container builds

Call `vahor-labs/actions/.github/workflows/build-app-image.yml@main` from a
main-branch push/dispatch or a `pull_request` workflow. The caller must grant
`contents: read`, `packages: write` and `pull-requests: write`.

Builds run on GitHub-hosted runners and publish Linux AMD64 images to the
caller's lowercase `ghcr.io/<owner>/<repository>` package:

- Main: `sha-<full commit SHA>`.
- Same-repository PR: `pr-<number>-<head SHA>`. A successful build adds
  `preview-ready` only while that PR is open at the built head.
- Fork PR: build only, without registry login, publication or preview labeling.

The build job receives no PR-write permission; the separate labeling job
receives no package-write permission. No deployment credentials or inherited
secrets are required. Do not call this workflow from `pull_request_target`.
