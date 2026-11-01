# Shared GitHub Actions

Public reusable workflows for `vahor-labs` applications. Infrastructure
deployment configuration and credentials remain in `ansible-configs`.

## Container builds

Two separate reusable workflows replace `build-app-image.yml`:

- `vahor-labs/actions/.github/workflows/main-build.yml@main`: main-branch
  push/dispatch. Caller grants `contents: read` and `packages: write`.
- `vahor-labs/actions/.github/workflows/pr-build.yml@main`: `pull_request`
  opened/synchronize/reopened. Caller grants `contents: read`, `packages: write`
  and `pull-requests: write`, and supplies the required `preview-url` input
  (for example, `https://my-app-${{ github.event.pull_request.number }}.preview.example.com`).
  Never use `pull_request_target`.

Builds run on GitHub-hosted runners and publish Linux AMD64 images to the
caller's lowercase `ghcr.io/<owner>/<repository>` package:

- Main: `sha-<full commit SHA>`, plus the `main` promotion tag for the current
  branch head only.
- Same-repository PR: `pr-<number>-<head SHA>`. A successful build adds
  `preview-ready` only while that PR is open at the built head.
- Fork PR: build only, without registry login, publication, comments or labeling.

Both workflows explicitly check out the actual commit (PR head, not GitHub's
synthetic merge commit), disable checkout credential persistence, and pass the
same full SHA as Docker build argument `APP_BUILD_SHA`.

Main runs are serialized per repository. After a successful SHA-image push,
the workflow checks GitHub's current `main` head before promoting the exact
build digest to `main`. Old reruns and builds overtaken by another commit may
publish their SHA image, but cannot promote it. The `main` tag represents the
last successfully promoted main build, not a promise that every newer commit
has already finished building. Consumers should track it by digest and commit
immutable `main@sha256:...` pins, not deploy the mutable tag directly. This avoids
choosing commits by image build timestamps or lexical SHA order. PR workflows
never publish or move `main`.

**Update preview comment** posts Building before the image build starts; it
does not build anything. **Wait for preview** labels and verifies the deployment
after the build. These status jobs receive PR-write but no package-write;
the build job receives package-write but no PR-write. No deployment credentials or inherited
secrets are required. Only the built-in `GITHUB_TOKEN` is used; no PAT, SSH,
production secrets or Argo credentials. Privileged status jobs use the shared
action from this repository's trusted `main`, never code checked out from a PR.

## Preview readiness and comment contract

The small composite action `.github/actions/preview-status` accepts `phase`
(`building`, `deploying`, or `failed`) and the caller's HTTPS `preview-url`.
It derives the PR number and full head SHA from the caller's original event payload.
It only edits comments by
`github-actions[bot]` containing the stable marker
`<!-- vahor-preview-status -->`. All comment pages are searched; human copies
of the marker are ignored. Subsequent runs update that same bot comment: a compact
**Deployment | Actions | Updated** table with logs and a commit link.
Ready links to the preview URL only after verification; there is no Project column.

1. **Building** replaces the previous state and removes any old preview link.
2. After publication, add `preview-ready` for ApplicationSet discovery, then
   show **Deploying** (not Ready).
3. Poll `<preview-url>/deployment.json` every 15 seconds
   for up to 15 minutes (allowing the ApplicationSet's 20-second discovery
   interval, rollout and certificate issuance). Each request has a maximum
   10-second timeout and a cache-busting query, requests no caching, and does
   not follow redirects or disable TLS verification. Network/TLS errors, 404s,
   invalid JSON and old/missing/short SHAs are retried. Logs show the URL, expected
   SHA, each attempt's elapsed time, HTTP status, observed SHA or probe error,
   and successful verification time.
4. **Ready** with the preview link is shown **only** after HTTP 200 with JSON
   `{"sha":"<exact full PR head SHA>"}`. The application's Dockerfile must bake
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
last Building/Deploying state). A deployment may of course change after a probe;
Ready records successful verification for the full SHA linked from the comment.

## Image cleanup

`vahor-labs/actions/.github/workflows/image-cleanup.yml@main` owns GHCR cleanup.
Callers grant `contents: read` and `packages: write`; no inherited secrets or
checkout is needed. The package is the caller's lowercase repository name,
under its organization or personal owner, matching the build workflows.

- On `pull_request: closed`, delete versions whose tags **all** belong to that
  PR (`pr-<number>-*`). Versions also carrying production or other PR tags are
  preserved because GHCR deletes whole versions, not individual tags.
- On `schedule` or `workflow_dispatch`, delete only untagged versions older
  than `older_than_hours` (a non-negative integer string, default `"24"`). Tagged
  and newer versions are preserved.

Keep the PR-closure, cron and manual triggers in each application repository;
reusable workflows inherit the caller's event. No image deletion runs on builds.

## Local verification

```sh
actionlint .github/workflows/*.yml
node --check .github/actions/preview-status/status.cjs
uvx --from check-jsonschema check-jsonschema --builtin-schema vendor.github-actions .github/actions/preview-status/action.yml
```

`actionlint` validates workflows, not composite-action
manifests; validate the composite's schema/step separately when changing it.
Use temporary behavior checks for readiness/freshness and cleanup selection;
do not delete real package versions just to validate selection logic.

## Delivery order

1. Deliver the website Dockerfile/runtime SHA endpoint contract and enable the
   preview infrastructure (public HTTPS route, ApplicationSet discovery via
   `preview-ready`, exact `pr-<number>-<head SHA>` tags) in their owning repos.
2. Publish this actions repository's new workflows and composite action on
   `main` **before** updating callers. The workflows also resolve the shared
   action from this repository at `@main`.
3. Deliver application callers pointing to `main-build.yml`, `pr-build.yml`
   (with `preview-url`) and `image-cleanup.yml`; then validate a real
   same-repository PR and a main build.

Coordinate changes to required inputs with all callers of `@main`. Local checks do
not prove GHCR access, real ApplicationSet rollout, TLS issuance or a live
GitHub comment update; those need the authorized post-delivery smoke test.
