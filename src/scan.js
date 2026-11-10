'use strict';

const fs = require('fs');
const path = require('path');
const { parsePin } = require('./version');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'tmp',
  'temp',
  '.turbo',
  '.output',
  'target',
]);

const ALL_LANGS = ['node', 'python', 'go'];

function isLikelyDockerfile(name) {
  return (
    name === 'Dockerfile' ||
    name.startsWith('Dockerfile.') ||
    name.endsWith('.Dockerfile')
  );
}

function isComposeFile(name) {
  return (
    name === 'docker-compose.yml' ||
    name === 'docker-compose.yaml' ||
    name === 'compose.yml' ||
    name === 'compose.yaml'
  );
}

function isWorkflowFile(filePath, name) {
  if (!/\.ya?ml$/i.test(name)) return false;
  const parts = filePath.split(path.sep);
  const idx = parts.lastIndexOf('.github');
  if (idx === -1) return false;
  return parts[idx + 1] === 'workflows';
}

/**
 * Walk a project tree and collect runtime version declarations.
 */
function normalizeIgnore(list) {
  const out = [];
  for (const raw of list || []) {
    for (const part of String(raw).split(',')) {
      const t = part.trim().replace(/^[.][/\\]/, '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (t) out.push(t);
    }
  }
  return out;
}

function isIgnored(rel, ignore) {
  if (!ignore || !ignore.length) return false;
  const norm = rel.replace(/\\/g, '/');
  return ignore.some((prefix) => norm === prefix || norm.startsWith(prefix + '/'));
}

function scan(root, options = {}) {
  const absRoot = path.resolve(root);
  const langs = normalizeLangs(options.langs);
  const ignore = normalizeIgnore(options.ignore);
  const declarations = [];
  const errors = [];

  walk(absRoot, absRoot, ignore, (rel, abs, stat) => {
    if (!stat.isFile()) return;
    const name = path.basename(abs);
    try {
      if (langs.includes('node') || langs.includes('python') || langs.includes('go')) {
        if (name === '.tool-versions') {
          declarations.push(...parseToolVersions(rel, readText(abs), langs));
          return;
        }
      }
      if (langs.includes('node')) {
        if (name === '.nvmrc' || name === '.node-version') {
          declarations.push(filePin('node', rel, firstNonCommentLine(readText(abs)), name === '.nvmrc' ? '.nvmrc' : '.node-version'));
          return;
        }
        if (name === 'package.json') {
          declarations.push(...parsePackageJson(rel, readText(abs)));
          return;
        }
      }
      if (langs.includes('python')) {
        if (name === '.python-version') {
          declarations.push(filePin('python', rel, firstNonCommentLine(readText(abs)), '.python-version'));
          return;
        }
        if (name === 'runtime.txt') {
          declarations.push(filePin('python', rel, firstNonCommentLine(readText(abs)), 'runtime.txt'));
          return;
        }
        if (name === 'pyproject.toml') {
          declarations.push(...parsePyproject(rel, readText(abs)));
          return;
        }
      }
      if (langs.includes('go')) {
        if (name === 'go.mod') {
          declarations.push(...parseGoMod(rel, readText(abs)));
          return;
        }
      }
      if (isLikelyDockerfile(name)) {
        declarations.push(...parseDockerfile(rel, readText(abs), langs));
        return;
      }
      if (isComposeFile(name)) {
        declarations.push(...parseCompose(rel, readText(abs), langs));
        return;
      }
      if (isWorkflowFile(rel, name)) {
        declarations.push(...parseWorkflow(rel, readText(abs), langs));
      }
    } catch (err) {
      errors.push({ file: rel, message: err.message || String(err) });
    }
  });

  return { root: absRoot, langs, ignore, declarations: declarations.filter(Boolean), errors };
}

function normalizeLangs(langs) {
  if (!langs || langs.length === 0) return [...ALL_LANGS];
  const out = [];
  for (const raw of langs) {
    const l = String(raw).trim().toLowerCase();
    const mapped = l === 'js' || l === 'nodejs' ? 'node'
      : l === 'py' ? 'python'
        : l === 'golang' ? 'go'
          : l;
    if (!ALL_LANGS.includes(mapped)) {
      throw new Error(`Unknown language "${raw}". Supported: ${ALL_LANGS.join(', ')}`);
    }
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function walk(absRoot, dir, ignore, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const name = ent.name;
    const abs = path.join(dir, name);
    const rel = path.relative(absRoot, abs) || name;
    if (isIgnored(rel, ignore)) continue;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(absRoot, path.join(dir, name), ignore, onFile);
      continue;
    }
    if (ent.isSymbolicLink()) continue;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    onFile(rel, abs, stat);
  }
}

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

function firstNonCommentLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t;
  }
  return '';
}

function filePin(lang, file, raw, source) {
  const pin = parsePin(lang, raw);
  return {
    lang,
    kind: pin.kind === 'version' ? 'pin' : pin.kind,
    source,
    file,
    raw: pin.raw || raw,
    major: pin.major,
    minor: pin.minor ?? null,
    patch: pin.patch ?? null,
    alias: pin.alias || null,
    matrix: false,
  };
}

function parseToolVersions(file, text, langs) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(nodejs|node|python|golang|go)\s+(\S+)/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const lang = key === 'nodejs' || key === 'node' ? 'node'
      : key === 'python' ? 'python'
        : 'go';
    if (!langs.includes(lang)) continue;
    out.push(filePin(lang, file, m[2], '.tool-versions'));
  }
  return out;
}

function parsePackageJson(file, text) {
  const out = [];
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }
  if (json && json.engines && json.engines.node) {
    out.push({
      lang: 'node',
      kind: 'range',
      source: 'package.json#engines.node',
      file,
      raw: String(json.engines.node),
      matrix: false,
    });
  }
  if (json && json.volta && json.volta.node) {
    out.push(filePin('node', file, String(json.volta.node), 'package.json#volta.node'));
  }
  if (json && json.devEngines && json.devEngines.runtime) {
    const rt = json.devEngines.runtime;
    const list = Array.isArray(rt) ? rt : [rt];
    for (const item of list) {
      if (item && (item.name === 'node' || item.name === 'nodejs') && item.version) {
        // devEngines.runtime.version may be a range or a pin; treat as range if it
        // looks like one, else a pin.
        const raw = String(item.version);
        if (/[<>^~=|]/.test(raw)) {
          out.push({
            lang: 'node',
            kind: 'range',
            source: 'package.json#devEngines.runtime',
            file,
            raw,
            matrix: false,
          });
        } else {
          out.push(filePin('node', file, raw, 'package.json#devEngines.runtime'));
        }
      }
    }
  }
  return out;
}

function parsePyproject(file, text) {
  const out = [];
  // Narrow parse: project.requires-python. Avoid a TOML dependency.
  const m = text.match(/^\s*requires-python\s*=\s*["']([^"']+)["']\s*$/m);
  if (m) {
    out.push({
      lang: 'python',
      kind: 'range',
      source: 'pyproject.toml#requires-python',
      file,
      raw: m[1],
      matrix: false,
    });
  }
  return out;
}

function parseGoMod(file, text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/);
    if (m) {
      out.push(filePin('go', file, m[1], 'go.mod#go'));
      break;
    }
  }
  return out;
}

const IMAGE_LANGS = [
  { re: /(?:^|\/)node$/i, lang: 'node' },
  { re: /(?:^|\/)python$/i, lang: 'python' },
  { re: /(?:^|\/)(?:golang|go)$/i, lang: 'go' },
];

function imageToDecl(file, source, image, langs) {
  const raw = String(image).trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(raw)) {
    // Cannot resolve build-arg / compose interpolation.
    const langGuess = guessLangFromImage(raw);
    if (!langGuess || !langs.includes(langGuess)) return null;
    return {
      lang: langGuess,
      kind: 'interpolation',
      source,
      file,
      raw,
      matrix: false,
    };
  }
  // image:tag or registry/repo/image:tag
  const noDigest = raw.split('@')[0];
  const parts = noDigest.split(':');
  const name = parts[0];
  const tag = parts.slice(1).join(':') || 'latest';
  const base = name.split('/').pop();
  let lang = null;
  for (const row of IMAGE_LANGS) {
    if (row.re.test(base)) {
      lang = row.lang;
      break;
    }
  }
  if (!lang || !langs.includes(lang)) return null;
  const pin = parsePin(lang, tag);
  return {
    lang,
    kind: pin.kind === 'version' ? 'pin' : pin.kind,
    source,
    file,
    raw: tag,
    image: raw,
    major: pin.major,
    minor: pin.minor ?? null,
    patch: pin.patch ?? null,
    alias: pin.alias || null,
    matrix: false,
  };
}

function guessLangFromImage(raw) {
  const lower = raw.toLowerCase();
  if (/node/.test(lower)) return 'node';
  if (/python/.test(lower)) return 'python';
  if (/golang|\bgo[:/]/.test(lower)) return 'go';
  return null;
}

function parseDockerfile(file, text, langs) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // FROM [--platform=...] image[:tag] [AS name]
    const m = t.match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/i);
    if (!m) continue;
    const decl = imageToDecl(file, 'Dockerfile#FROM', m[1], langs);
    if (decl) out.push(decl);
  }
  return out;
}

function parseCompose(file, text, langs) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*image:\s*(.+?)\s*$/);
    if (!m) continue;
    const decl = imageToDecl(file, 'compose#image', m[1], langs);
    if (decl) out.push(decl);
  }
  return out;
}

function parseWorkflow(file, text, langs) {
  const out = [];
  const matrices = extractMatrices(text);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const uses = lines[i].match(/^\s*(?:-\s*)?uses:\s*['"]?actions\/setup-(node|python|go)@/);
    if (!uses) continue;
    const setup = uses[1];
    const lang = setup === 'node' ? 'node' : setup === 'python' ? 'python' : 'go';
    if (!langs.includes(lang)) continue;

    const prefix = lang === 'node' ? 'node' : lang === 'python' ? 'python' : 'go';
    let versionRaw = null;
    let versionFile = null;
    for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
      const line = lines[j];
      if (/^\s*(?:-\s*)?uses:/.test(line)) break;
      if (/^\s{0,2}\S/.test(line) && !/^\s+/.test(line)) break;
      const vf = line.match(new RegExp(`^\\s*${prefix}-version-file:\\s*(.+?)\\s*$`));
      if (vf) {
        versionFile = stripYamlScalar(vf[1]);
        continue;
      }
      const v = line.match(new RegExp(`^\\s*${prefix}-version:\\s*(.+?)\\s*$`));
      if (v) {
        versionRaw = stripYamlScalar(v[1]);
      }
    }

    if (versionFile) {
      out.push({
        lang,
        kind: 'version-file-ref',
        source: `actions/setup-${setup}#${prefix}-version-file`,
        file,
        raw: versionFile,
        matrix: false,
      });
    }

    if (!versionRaw) continue;

    if (/\$\{\{\s*matrix\./.test(versionRaw)) {
      const key = matrixKeyFromExpr(versionRaw);
      const values = (key && matrices[key]) || [];
      if (!values.length) {
        out.push({
          lang,
          kind: 'matrix-unresolved',
          source: `actions/setup-${setup}#${prefix}-version`,
          file,
          raw: versionRaw,
          matrix: true,
        });
        continue;
      }
      for (const val of values) {
        const pin = parsePin(lang, val);
        out.push({
          lang,
          kind: pin.kind === 'version' ? 'pin' : pin.kind,
          source: `actions/setup-${setup}#matrix.${key}`,
          file,
          raw: pin.raw || val,
          major: pin.major,
          minor: pin.minor ?? null,
          patch: pin.patch ?? null,
          alias: pin.alias || null,
          matrix: true,
        });
      }
      continue;
    }

    const pin = parsePin(lang, versionRaw);
    out.push({
      lang,
      kind: pin.kind === 'version' ? 'pin' : pin.kind,
      source: `actions/setup-${setup}#${prefix}-version`,
      file,
      raw: pin.raw || versionRaw,
      major: pin.major,
      minor: pin.minor ?? null,
      patch: pin.patch ?? null,
      alias: pin.alias || null,
      matrix: false,
    });
  }
  return out;
}

function stripYamlScalar(s) {
  let t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  return t;
}

function matrixKeyFromExpr(expr) {
  const m = expr.match(/matrix\.([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * Best-effort extraction of GitHub Actions matrix lists. Handles:
 *   node: [18, 20, 22]
 *   node-version: ['18', "20"]
 *   node:
 *     - 18
 *     - 20
 * This is not a full YAML parser (anchors, complex expressions are skipped).
 */
function extractMatrices(text) {
  const maps = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*\[([^\]]*)\]\s*$/);
    if (inline && /node|python|go|version|runtime/i.test(inline[1])) {
      maps[inline[1]] = splitInlineList(inline[2]);
      continue;
    }
    const block = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*$/);
    if (block && /node|python|go|version|runtime/i.test(block[1])) {
      const items = [];
      const indent = lines[i].match(/^\s*/)[0].length;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '' || lines[j].trim().startsWith('#')) continue;
        const m = lines[j].match(/^(\s*)-\s+(.+?)\s*$/);
        if (!m || m[1].length <= indent) break;
        items.push(stripYamlScalar(m[2]));
      }
      if (items.length) maps[block[1]] = items;
    }
  }
  return maps;
}

function splitInlineList(s) {
  return s
    .split(',')
    .map((x) => stripYamlScalar(x))
    .filter(Boolean);
}

module.exports = {
  scan,
  normalizeLangs,
  normalizeIgnore,
  isIgnored,
  ALL_LANGS,
  SKIP_DIRS,
  parseWorkflow,
  parseDockerfile,
  parseCompose,
  parsePackageJson,
  parsePyproject,
  parseGoMod,
  parseToolVersions,
  extractMatrices,
};
