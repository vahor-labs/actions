# Contributing

Small fixes are welcome without an issue first. For larger changes, open an
issue to agree on the scope before starting.

## Setup and checks

Fork and clone this repository, then create a branch for your change. Install
Node.js, [actionlint](https://github.com/rhysd/actionlint), and
[uv](https://docs.astral.sh/uv/). There is no dependency installation step.

Run from the repository root:

```sh
actionlint .github/workflows/*.yml
node --check .github/actions/preview-status/status.cjs
uvx --from check-jsonschema check-jsonschema --builtin-schema vendor.github-actions .github/actions/preview-status/action.yml
```

For behavior changes, also check representative event payloads and failure
cases with disposable fixtures. Do not publish images, delete package versions,
or mutate real pull requests just to test locally. Keep fork builds unprivileged
and never use `pull_request_target` to run untrusted code.

## Pull requests and reports

Keep changes focused. Explain the problem, the approach, and the checks you ran
(including anything you could not verify). Coordinate changes to reusable
workflow inputs and outputs with callers; local checks do not prove live GitHub
or registry behavior. Live checks require separate authorization.

Use the issue forms for bugs and feature requests. Reports and pull requests
are public: never include credentials, private configurations, private URLs,
or unsanitized logs. Use minimal examples with placeholder values instead.
