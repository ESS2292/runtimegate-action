'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');
const { scan, parseWorkflow, extractMatrices, stripYamlScalar, parseToolVersions, parseMiseToml, parseDevcontainer, isLikelyDockerfile, isComposeFile } = require('../src/scan');
const { analyze } = require('../src/compare');
const { parseNodePin, pinSatisfiesRange } = require('../src/version');
const { runCheck } = require('../src/index');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rglite-reg-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function capture(env, cwd) {
  const lines = [];
  const code = run({ ...env }, { cwd, log: (s) => lines.push(s) });
  return { code, lines };
}

describe('YAML inline comments', () => {
  it('strips comments from quoted setup-node pins', () => {
    assert.equal(stripYamlScalar('"24" # Should be the same as the version used on Netlify'), '24');
    const yaml = `
jobs:
  docs:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "24" # Should be the same as the version used on Netlify
`;
    const decls = parseWorkflow('.github/workflows/ci.yml', yaml, ['node']);
    assert.equal(decls[0].kind, 'pin');
    assert.equal(decls[0].major, 24);
    assert.equal(decls[0].raw, '24');
  });

  it('strips trailing comments from inline matrix lists', () => {
    const maps = extractMatrices('    node-version: [20.x, 22.x] # comment\n');
    assert.deepEqual(maps['node-version'], ['20.x', '22.x']);
  });
});

describe('20.x matrix values', () => {
  it('parses 20.x as Node 20 and treats it as the latest 20.x for engines', () => {
    const pin = parseNodePin('20.x');
    assert.equal(pin.kind, 'version');
    assert.equal(pin.major, 20);
    assert.equal(pin.wildcard, true);
    assert.equal(pinSatisfiesRange(pin, '^20.19.0 || >=24').ok, true);
    assert.equal(pinSatisfiesRange(pin, '>=24').ok, false);
  });

  it('expands a 20.x matrix entry to a Node 20 pin', () => {
    const yaml = `
jobs:
  test:
    strategy:
      matrix:
        node: [20.x, 24.x]
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
`;
    const decls = parseWorkflow('.github/workflows/ci.yml', yaml, ['node']);
    const majors = decls.filter((d) => d.matrix).map((d) => d.major).sort();
    assert.deepEqual(majors, [20, 24]);
  });
});

describe('docker/build Dockerfiles', () => {
  it('scans docker/build Dockerfiles and still skips a top-level build dir', () => {
    const dir = makeRepo({
      'docker/build/x86_64/Dockerfile': 'FROM node:24-alpine\n',
      'build/Dockerfile': 'FROM node:18-alpine\n',
      '.nvmrc': '20\n',
    });
    try {
      const result = scan(dir, { langs: ['node'] });
      const files = result.declarations.map((d) => d.file.replace(/\\/g, '/'));
      assert.ok(files.includes('docker/build/x86_64/Dockerfile'), files.join(','));
      assert.ok(!files.some((f) => f.startsWith('build/')), files.join(','));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the action when CI is on Node 20 and docker/build is on Node 24', () => {
    const dir = makeRepo({
      'docker/build/x86_64/Dockerfile': 'FROM node:24-alpine\n',
      '.github/workflows/build.yml': `
jobs:
  test:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
`,
    });
    try {
      const { code, lines } = capture({ INPUT_EOL: 'false' }, dir);
      assert.equal(code, 1);
      assert.ok(lines.some((l) => l.includes('major-mismatch')), lines.join('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('monorepo engines scope', () => {
  const files = {
    'package.json': '{"engines":{"node":"^20.19.0 || ^22.13.0 || >=24"}}\n',
    'docs/package.json': '{"engines":{"node":">=24"}}\n',
    '.github/workflows/ci.yml': `
jobs:
  test:
    strategy:
      matrix:
        node: [20.19.0, 20.x, 24.x]
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
`,
  };

  it('does not compare nested engines to the root CI matrix by default', () => {
    const dir = makeRepo(files);
    try {
      const { code, lines } = capture({ INPUT_EOL: 'false' }, dir);
      assert.equal(code, 0, lines.join('\n'));
      assert.ok(!lines.some((l) => l.includes('range-unsatisfied')), lines.join('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compares every range to every pin when engines-scope is all', () => {
    const dir = makeRepo(files);
    try {
      const { code, lines } = capture({ INPUT_EOL: 'false', 'INPUT_ENGINES-SCOPE': 'all' }, dir);
      assert.equal(code, 1, lines.join('\n'));
      assert.ok(lines.some((l) => l.includes('range-unsatisfied')), lines.join('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still flags a pin inside the nested workspace that misses that package range', () => {
    const dir = makeRepo({
      'package.json': '{"engines":{"node":">=20"}}\n',
      'docs/package.json': '{"engines":{"node":">=24"}}\n',
      'docs/Dockerfile': 'FROM node:20-alpine\n',
    });
    try {
      const result = runCheck({ root: dir, langs: ['node'] });
      assert.equal(result.ok, false);
      assert.ok(result.findings.some((f) =>
        f.code === 'range-unsatisfied' && /docs\/Dockerfile/.test(f.message)
      ));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('new Node version sources (v1.1.0)', () => {
  it('matches Dockerfile-CUDA, Dockerfile.dev, and *.dockerfile', () => {
    assert.equal(isLikelyDockerfile('Dockerfile-CUDA'), true);
    assert.equal(isLikelyDockerfile('Dockerfile.dev'), true);
    assert.equal(isLikelyDockerfile('app.dockerfile'), true);
    assert.equal(isLikelyDockerfile('dockerignore'), false);
  });

  it('matches compose override and compose.test.yml filenames', () => {
    assert.equal(isComposeFile('compose.override.yaml'), true);
    assert.equal(isComposeFile('compose.test.yml'), true);
    assert.equal(isComposeFile('docker-compose.dev.yaml'), true);
    assert.equal(isComposeFile('services.yml'), false);
  });

  it('reads nodejs lines and comments from .tool-versions', () => {
    const decls = parseToolVersions('.tool-versions', 'nodejs 22.21.1 # comment\nyarn 1.22.19\n', ['node']);
    assert.equal(decls.length, 1);
    assert.equal(decls[0].major, 22);
    assert.equal(decls[0].patch, 1);
  });

  it('reads node from mise.toml', () => {
    const decls = parseMiseToml('mise.toml', '[tools]\nnode = "22.22.3"\nyarn = "1"\n', ['node']);
    assert.equal(decls.length, 1);
    assert.equal(decls[0].source, 'mise.toml#tools');
    assert.equal(decls[0].major, 22);
    assert.equal(decls[0].patch, 3);
  });

  it('reads a javascript-node devcontainer image and a Node feature from JSONC', () => {
    const decls = parseDevcontainer('.devcontainer/devcontainer.json', `{
      // comment
      "image": "mcr.microsoft.com/devcontainers/javascript-node:22-bookworm",
      "features": {
        "ghcr.io/devcontainers/features/node:2": { "version": "22" },
      }
    }`, ['node']);
    assert.equal(decls.length, 2);
    assert.ok(decls.some((d) => d.source === 'devcontainer.json#image' && d.major === 22));
    assert.ok(decls.some((d) => d.source === 'devcontainer.json#features' && d.major === 22));
  });

  it('scans the new filenames together', () => {
    const dir = makeRepo({
      '.node-version': '22.11.0\n',
      'package.json': JSON.stringify({ volta: { node: '22.11.0' }, engines: { node: '>=22' } }),
      'mise.toml': '[tools]\nnode = "22.11.0"\n',
      '.tool-versions': 'nodejs 22.11.0\n',
      'Dockerfile-CUDA': 'FROM node:22.11.0-alpine\n',
      'compose.test.yml': 'services:\n  app:\n    image: node:22.11.0-alpine\n',
      '.devcontainer/devcontainer.json': '{ "image": "mcr.microsoft.com/devcontainers/javascript-node:22" }\n',
    });
    try {
      const result = scan(dir, { langs: ['node'] });
      const sources = result.declarations.map((d) => d.source);
      assert.ok(sources.includes('.node-version'), sources.join(','));
      assert.ok(sources.includes('package.json#volta.node'));
      assert.ok(sources.includes('mise.toml#tools'));
      assert.ok(sources.includes('.tool-versions'));
      assert.ok(sources.includes('Dockerfile#FROM'));
      assert.ok(sources.includes('compose#image'));
      assert.ok(sources.includes('devcontainer.json#image'));
      const report = analyze(result);
      assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats setup-node node-version 22 as the latest 22.x against engines >= 22.21.0', () => {
    const dir = makeRepo({
      '.tool-versions': 'nodejs 22.21.1\n',
      'package.json': JSON.stringify({ engines: { node: '>= 22.21.0' } }),
      '.github/workflows/ci.yml': `jobs:
  test:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
`,
    });
    try {
      const report = analyze(scan(dir, { langs: ['node'] }));
      assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
      assert.ok(!report.findings.some((f) => f.code === 'range-unsatisfied'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
