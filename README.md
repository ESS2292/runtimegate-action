# RuntimeGate Lite — GitHub Action

[![CI](https://github.com/ESS2292/runtimegate-action/actions/workflows/test.yml/badge.svg)](https://github.com/ESS2292/runtimegate-action/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/ESS2292/runtimegate-action)](https://github.com/ESS2292/runtimegate-action/releases/latest)

Fail a GitHub Actions job when Node.js version pins in the repository disagree.

A `.nvmrc` file, a Dockerfile, and a `setup-node` step are three places a Node version can be declared — and they drift. CI can pass on one major while the production image builds another. This Action scans those declarations (Node.js only) and fails the job when they do not agree.

- **Zero dependencies.** Plain Node.js, nothing to install, nothing in `node_modules`.
- **Node.js only.** Python, Go, `--json`, and a local CLI are described on the [RuntimeGate site](https://ess2292.github.io/runtimegate/).
- **Optional end-of-support check.** The `eol` input uses vendored official dates and does not call the network.
- **Free and MIT-licensed.**

The scanner modules under `src/` (except `main.js`) are vendored from RuntimeGate 0.1.0 and restricted to Node.js by the Action wrapper.

The pre-launch product page (not indexed; checkout is not live) is at [ess2292.github.io/runtimegate](https://ess2292.github.io/runtimegate/).

## Usage

### Check the repository root

```yaml
name: CI
on: [push, pull_request]

jobs:
  runtime:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Check Node.js version pins
        uses: ESS2292/runtimegate-action@v1
        with:
          eol: "true"
```

### Check a subdirectory

```yaml
      - uses: ESS2292/runtimegate-action@v1
        with:
          root: apps/web
          eol: "false"
```

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `root` | `.` | Project directory to scan, relative to the workspace |
| `eol` | `false` | If `true`, also fail when a Node.js pin is past official end of support |
| `ignore` | (empty) | Comma-separated relative path prefixes to skip |
| `engines-scope` | `workspace` | How `package.json` engines ranges are compared to pins. `workspace` only compares a range to pins in the same package directory (GitHub workflows belong to the repo root). `all` compares every range to every pin. |

## Outputs

| Output | Meaning |
| --- | --- |
| `ok` | `true` if the check passed, otherwise `false` |
| `errors` | Number of error findings |
| `warnings` | Number of warning findings (these do not fail the job) |
| `codes` | Comma-separated error codes, empty when there are no errors |

## What it looks at

`.nvmrc`, `.node-version`, `.tool-versions` (Node lines), `package.json` engines / Volta / `devEngines`, `FROM node:…` in Dockerfiles, Compose `image: node:…`, and `actions/setup-node` (`node-version` and `node-version-file`, including a simple matrix).

Errors: Node **major** mismatch between pins; a pin that cannot satisfy the declared engines range; with `eol: true`, a pin past official end of support.

Warnings (do not fail the job): patch-level disagreement, floating tags such as `latest`, unresolved interpolation, a hardcoded `node-version` when a version file is also present.

A CI matrix is not treated as a mismatch against a single Dockerfile. Matrix entries that fall outside a declared engines range still fail. Values such as `20.x` are treated as the latest release on that line. Trailing YAML comments on workflow pins are ignored.

Directories named `build` are skipped as compile output, except under `docker/` or `dockerfiles/`, so `docker/build/*/Dockerfile` is still scanned.

By default, `engines` ranges are scoped to the workspace that declared them. A nested `docs/package.json` engines field is not compared to the root CI matrix. Set `engines-scope: all` to compare every range to every pin.

## Honest limits

- Node.js only. Python, Go, a JSON report, and a local CLI are described on the [RuntimeGate site](https://ess2292.github.io/runtimegate/). Checkout is not live.
- Not a full YAML parser. Anchors and generated matrix expressions can be missed. Inline comments and `20.x`-style matrix values are supported.
- Does not expand Docker `ARG` interpolation.
- End-of-support dates are a snapshot (10 November 2026) in `src/eol.js`, from the official [Node.js release schedule](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json). Node 20 ended 30 April 2026.
- This is a consistency gate, not a guarantee that production runs the pinned version.

## Development

```bash
node --test
```

`.github/workflows/test.yml` runs the tests and self-tests the action with `uses: ./`, including a drift fixture that is expected to fail.

The action runs on the `node24` runtime, which GitHub-hosted runners require for JavaScript actions since Node 20 was removed in September 2026.

## Guides

- [Do your .nvmrc, Dockerfile, and CI agree on Node.js?](https://ess2292.github.io/runtimegate/guides/nvmrc-dockerfile-ci-node-version-drift.html)
- [Use a version file in GitHub Actions so CI cannot drift](https://ess2292.github.io/runtimegate/guides/github-actions-node-version-file.html)
- [Node 20 is past end of support — find every pin in the repo](https://ess2292.github.io/runtimegate/guides/find-eol-node-pins-after-node-20.html)

Questions and bug reports: [open an issue](https://github.com/ESS2292/runtimegate-action/issues).

## Changelog

### v1.0.1

- Scan Dockerfiles under `docker/build` (directories named `build` are still skipped elsewhere).
- Strip YAML inline comments from workflow pins and matrix lists (`node-version: "24" # used on Netlify`).
- Parse GitHub-style `20.x` matrix values (treated as the latest release on that line).
- Scope `package.json` engines to the workspace that declared them. New `engines-scope` input; default `workspace`. Set `all` for the previous repo-wide comparison.
- Parse engines ranges with a space after the operator (`">= 20"`).

### v1.0.0

- Initial public release of RuntimeGate Lite.

## Related

RuntimeGate checks whether runtime version pins agree. For missing environment variables, use the free [EnvGate Lite Action](https://github.com/ESS2292/envgate-action). For mixed lockfiles or an unfrozen install in CI, use the free [LockGate Lite Action](https://github.com/ESS2292/lockgate-action).

## License

MIT. Copyright 2026 Emilio Straubel.
