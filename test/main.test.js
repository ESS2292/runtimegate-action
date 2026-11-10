'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');

function capture(env, cwd) {
  const lines = [];
  const code = run({ ...env }, { cwd, log: (s) => lines.push(s) });
  return { code, lines };
}

describe('RuntimeGate Lite action', () => {
  it('passes on a clean Node pin set', () => {
    const cwd = path.join(__dirname, 'fixtures/clean');
    const { code, lines } = capture({ INPUT_ROOT: '.', INPUT_EOL: 'false' }, cwd);
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(lines.some((l) => /OK/i.test(l) || /agree/i.test(l)));
  });

  it('fails when majors drift', () => {
    const cwd = path.join(__dirname, 'fixtures/drift');
    const { code, lines } = capture({ INPUT_ROOT: '.', INPUT_EOL: 'false' }, cwd);
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes('major-mismatch')), lines.join('\n'));
  });

  it('does not flag Node 22 as EOL on the vendored snapshot, and does flag Node 20 when eol=true', () => {
    const clean = path.join(__dirname, 'fixtures/clean');
    const ok = capture({ INPUT_EOL: 'true' }, clean);
    assert.equal(ok.code, 0, ok.lines.join('\n'));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rglite-eol-'));
    fs.writeFileSync(path.join(dir, '.nvmrc'), '20\n');
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:20-alpine\n');
    try {
      const off = capture({ INPUT_EOL: 'false' }, dir);
      assert.equal(off.code, 0, off.lines.join('\n'));
      const on = capture({ INPUT_EOL: 'true' }, dir);
      assert.equal(on.code, 1);
      assert.ok(on.lines.some((l) => l.includes('eol')), on.lines.join('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 1 when the scan root is missing', () => {
    const { code, lines } = capture({ INPUT_ROOT: 'does-not-exist' }, __dirname);
    assert.equal(code, 1);
    assert.ok(lines.some((l) => /::error/.test(l)));
  });

  it('writes GitHub outputs when GITHUB_OUTPUT is set', () => {
    const out = path.join(os.tmpdir(), `rglite-out-${process.pid}.txt`);
    try {
      if (fs.existsSync(out)) fs.unlinkSync(out);
      const cwd = path.join(__dirname, 'fixtures/drift');
      const { code } = capture({ INPUT_ROOT: '.', GITHUB_OUTPUT: out }, cwd);
      assert.equal(code, 1);
      const text = fs.readFileSync(out, 'utf8');
      assert.match(text, /^ok=false$/m);
      assert.match(text, /^codes=major-mismatch/m);
    } finally {
      try { fs.unlinkSync(out); } catch { /* ignore */ }
    }
  });

  it('honors the ignore input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rglite-ign-'));
    fs.writeFileSync(path.join(dir, '.nvmrc'), '22\n');
    fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'examples', '.nvmrc'), '18\n');
    fs.writeFileSync(path.join(dir, 'examples', 'Dockerfile'), 'FROM node:18-alpine\n');
    try {
      const unfiltered = capture({ INPUT_IGNORE: '' }, dir);
      assert.equal(unfiltered.code, 1);
      const skipped = capture({ INPUT_IGNORE: 'examples' }, dir);
      assert.equal(skipped.code, 0, skipped.lines.join('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
