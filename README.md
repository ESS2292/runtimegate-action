# RuntimeGate Lite — GitHub Action

Fail a GitHub Actions job when Node.js version pins in the repository disagree.

A `.nvmrc` file, a Dockerfile, and a `setup-node` step are three places a Node version can be declared — and they drift. CI can pass on one major while the production image builds another. This Action scans those declarations (Node.js only) and fails the job when they do not agree.

- **Zero dependencies.** Plain Node.js, nothing to install, nothing in `node_modules`.
- **Node.js only.** Python and Go, `--json`, and a local CLI are in the full RuntimeGate package.
- **Optional end-of-support check.** The `eol` input uses vendored official dates and does not call the network.
- **Free and MIT-licensed.** This tree is not published to GitHub yet.

The scanner modules under `src/` (except `main.js`) are vendored from RuntimeGate 0.1.0 and restricted to Node.js by the Action wrapper.

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
        uses: ./
        # After this Action is published, replace ./ with OWNER/runtimegate-action@v1
        with:
          eol: "true"
```

### Check a subdirectory

```yaml
      - uses: ./
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

A CI matrix is not treated as a mismatch against a single Dockerfile. Matrix entries that fall outside a declared engines range still fail.

## Honest limits

- Node.js only. For Python and Go, use the full RuntimeGate CLI.
- Not a full YAML parser. Unusual workflow matrices or anchors can be missed.
- Does not expand Docker `ARG` interpolation.
- End-of-support dates are a snapshot (10 November 2026) in `src/eol.js`, from the official [Node.js release schedule](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json). Node 20 ended 30 April 2026.
- This is a consistency gate, not a guarantee that production runs the pinned version.

## License

MIT. Copyright 2026 Emilio Straubel.
