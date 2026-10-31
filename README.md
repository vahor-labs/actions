# Shared GitHub Actions

Public reusable workflows for `vahor-labs` applications. Infrastructure
deployment configuration and credentials remain in `ansible-configs`.

## Container builds

Two separate reusable workflows replace `build-app-image.yml`:

- `vahor-labs/actions/.github/workflows/main-build.yml@main`: main-branch
  push/dispatch. Caller grants `contents: read` and `packages: write`.
- `vahor-labs/actions/.github/workflows/pr-build.yml@main`: `pull_request`
  opened/synchronize/reopened. Caller grants `contents: read`, `packages: write`
  and `pull-requests: write`. Never use `pull_request_target`.

Builds run on GitHub-hosted runners and publish Linux AMD64 images to the
caller's lowercase `ghcr.io/<owner>/<repository>` package:

- Main: `sha-<full commit SHA>`.
- Same-repository PR: `pr-<number>-<head SHA>`. A successful build adds
  `preview-ready` only while that PR is open at the built head.
- Fork PR: build only, without registry login, publication, comments or labeling.

Both workflows explicitly check out the actual commit (PR head, not GitHub's
synthetic merge commit), disable checkout credential persistence, and pass the
same full SHA as Docker build argument `APP_BUILD_SHA`. No mutable image tags
are published.

The build job receives no PR-write permission; the separate labeling job
receives no package-write permission. No deployment credentials or inherited
secrets are required. Only the built-in `GITHUB_TOKEN` is used; no PAT, SSH,
production secrets or Argo credentials. Privileged status jobs use the shared
action from this repository's trusted `main`, never code checked out from a PR.

## Preview readiness and comment contract

The small composite action `.github/actions/preview-status` accepts one input,
`phase`: `building`, `deploying`, or `failed`. It derives the PR number and full
head SHA from the caller's original event payload. It only edits comments by
`github-actions[bot]` containing the stable marker
`<!-- vahor-preview-status -->`. All comment pages are searched; human copies
of the marker are ignored. Subsequent runs update that same bot comment.

1. **Building** replaces the previous state and removes any old preview link.
2. After publication, add `preview-ready` for ApplicationSet discovery, then
   show **Deploying / Waiting** (not Ready).
3. Poll `https://vahor-fr-<PR>.preview.vahor.fr/deployment.json` every 15 seconds
   for up to 15 minutes (allowing the ApplicationSet's 300-second discovery
   interval, rollout and certificate issuance). Each request has a maximum
   10-second timeout and a cache-busting query, requests no caching, and does
   not follow redirects or disable TLS verification. Network/TLS errors, 404s,
   invalid JSON and old/missing/short SHAs are retried.
4. **Ready** with the preview link is shown **only** after HTTP 200 with JSON
   `{"sha":"<exact full PR head SHA>"}`. The website Dockerfile must bake
   `APP_BUILD_SHA` into the final runtime image, and the endpoint must return
   the runtime SHA with `Cache-Control: no-store`. Neither is implemented here.
5. Build errors show **Build failed**; exhausted readiness polling shows
   **Deployment timed out** and fails the job; API errors show
   **Deployment failed** when GitHub remains writable and fail the job. None
   of these states include a preview link. The discovery label remains after
   a timeout so deployment can still converge; rerun to verify readiness.

Runs are grouped by repository/PR with `cancel-in-progress: true`. PR open/head
is rechecked immediately before every comment mutation and label addition,
and on each poll. Closed/superseded runs stop without overwriting status.
As with all GitHub REST clients, the read-head/write-comment pair is not a
server-side atomic transaction; concurrency cancellation plus these immediate
checks guard against stale runs. Cancelled runs deliberately do not write a
final status (a newer run owns the comment; manual cancellation can leave the
last Building/Waiting state). A deployment may of course change after a probe;
Ready records successful verification for the SHA printed in the comment.

## Local verification

```sh
actionlint .github/workflows/main-build.yml .github/workflows/pr-build.yml
node --test .github/actions/preview-status/status.test.cjs
uvx --from check-jsonschema check-jsonschema --builtin-schema vendor.github-actions .github/actions/preview-status/action.yml
```

The dependency-free Node tests exercise the sticky-comment and PR freshness
logic with GitHub mocks, and the actual fetch readiness check against a local
HTTP server (including wrong-SHA HTTP 200 responses). They do not deploy or
make GitHub API writes. `actionlint` validates workflows, not composite-action
manifests; validate the composite's schema/step separately when changing it.

## Delivery order

1. Deliver the website Dockerfile/runtime SHA endpoint contract and enable the
   preview infrastructure (public HTTPS route, ApplicationSet discovery via
   `preview-ready`, exact `pr-<number>-<head SHA>` tags) in their owning repos.
2. Publish this actions repository's new workflows and composite action on
   `main` **before** updating callers. The workflows also resolve the shared
   action from this repository at `@main`.
3. Deliver the two website workflow callers pointing to `main-build.yml` and
   `pr-build.yml`; then validate a real same-repository PR and a main build.

The old reusable workflow is removed in this change. Coordinate that removal
with all existing consumers (or retain it temporarily during a staged rollout)
to avoid a window where old callers reference a missing file. Local checks do
not prove GHCR access, real ApplicationSet rollout, TLS issuance or a live
GitHub comment update; those need the authorized post-delivery smoke test.
