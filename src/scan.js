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

/**
 * Dockerfile filename heuristic. Docker's default name is "Dockerfile";
 * `docker build -f` and Compose `dockerfile:` accept any path. This matches
 * common variants: Dockerfile, Dockerfile.dev, Dockerfile-CUDA, dockerfile,
 * and *.dockerfile (any case).
 */
function isLikelyDockerfile(name) {
  const lower = String(name).toLowerCase();
  if (lower === 'dockerfile') return true;
  if (lower.startsWith('dockerfile.') || lower.startsWith('dockerfile-')) return true;
  if (lower.endsWith('.dockerfile')) return true;
  return false;
}

/**
 * Official Compose default files plus override and -f variants.
 * https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/
 */
function isComposeFile(name) {
  const lower = String(name).toLowerCase();
  if (lower === 'docker-compose.yml' || lower === 'docker-compose.yaml') return true;
  if (lower === 'compose.yml' || lower === 'compose.yaml') return true;
  const yaml = lower.endsWith('.yml') || lower.endsWith('.yaml');
  if (!yaml) return false;
  return lower.startsWith('docker-compose.') || lower.startsWith('compose.');
}

function isMiseConfig(rel, name) {
  const lower = String(name).toLowerCase();
  if (lower === 'mise.toml' || lower === '.mise.toml') return true;
  const norm = String(rel).replace(/\\/g, '/').toLowerCase();
  if (norm === '.config/mise.toml' || /(^|\/)\.config\/mise\/(config|mise)\.toml$/.test(norm)) return true;
  if (/(^|\/)mise\/config\.toml$/.test(norm) || /(^|\/)\.mise\/config\.toml$/.test(norm)) return true;
  return false;
}

function isDevcontainerFile(name) {
  return String(name).toLowerCase() === 'devcontainer.json';
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

/**
 * Skip compile-output directories, but keep walking a "build" directory
 * when it lives under docker/ or dockerfiles/ (for example
 * docker/build/x86_64/Dockerfile).
 */
function shouldSkipDir(name, rel) {
  if (!SKIP_DIRS.has(name)) return false;
  if (name === 'build' && isDockerContext(rel)) return false;
  return true;
}

function isDockerContext(rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  return parts.some((part) => part === 'docker' || part === 'dockerfiles');
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
      if (name === '.tool-versions') {
        declarations.push(...parseToolVersions(rel, readText(abs), langs));
        return;
      }
      if (isMiseConfig(rel, name)) {
        declarations.push(...parseMiseToml(rel, readText(abs), langs));
        return;
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
      if (isDevcontainerFile(name)) {
        declarations.push(...parseDevcontainer(rel, readText(abs), langs));
        return;
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
      if (shouldSkipDir(name, rel)) continue;
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
    wildcard: Boolean(pin.wildcard),
    matrix: false,
  };
}

const TOOL_NAME_TO_LANG = {
  node: 'node',
  nodejs: 'node',
  python: 'python',
  go: 'go',
  golang: 'go',
};

function stripHashComment(line) {
  const s = String(line);
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < s.length) {
        i += 1;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '#') return s.slice(0, i);
  }
  return s;
}

function parseToolVersions(file, text, langs) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = stripHashComment(line).trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 2) continue;
    const lang = TOOL_NAME_TO_LANG[parts[0].toLowerCase()];
    if (!lang || !langs.includes(lang)) continue;
    out.push(filePin(lang, file, parts[1], '.tool-versions'));
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
  { re: /(?:^|\/)(?:javascript-node|typescript-node)$/i, lang: 'node' },
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
    wildcard: Boolean(pin.wildcard),
    matrix: false,
  };
}

function guessLangFromImage(raw) {
  const lower = raw.toLowerCase();
  if (/javascript-node|typescript-node|node/.test(lower)) return 'node';
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


function markActionsLinePin(lang, pin) {
  if (!pin || (pin.kind !== 'version' && pin.kind !== 'pin')) return pin;
  if (pin.wildcard) return pin;
  if (lang === 'node' && pin.minor == null) pin.wildcard = true;
  else if ((lang === 'python' || lang === 'go') && pin.patch == null) pin.wildcard = true;
  return pin;
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
        const pin = markActionsLinePin(lang, parsePin(lang, val));
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
          wildcard: Boolean(pin.wildcard),
          matrix: true,
        });
      }
      continue;
    }

    const pin = markActionsLinePin(lang, parsePin(lang, versionRaw));
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
      wildcard: Boolean(pin.wildcard),
      matrix: false,
    });
  }
  return out;
}

/**
 * Strip an unquoted YAML # comment, then surrounding quotes.
 * `"24" # used on Netlify` becomes 24. A hash inside quotes is kept.
 */
function stripInlineYamlComment(s) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      if (c === "'") {
        if (s[i + 1] === "'") {
          i += 1;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < s.length) {
        i += 1;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '#') return s.slice(0, i).trimEnd();
  }
  return s;
}

function stripYamlScalar(s) {
  let t = stripInlineYamlComment(String(s).trim()).trim();
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
    const inline = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*\[([^\]]*)\]\s*(?:#.*)?$/);
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

function unquoteTomlKey(s) {
  let t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  return t;
}

function unquoteTomlString(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function versionFromTomlValue(raw) {
  const t = String(raw).trim();
  if (!t) return null;
  // inline table: { version = "24", os = ["linux"] }
  if (t.startsWith('{') && t.endsWith('}')) {
    const m = t.match(/\bversion\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,}\s]+))/);
    if (!m) return null;
    return m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
  }
  // array of versions: ["24", "22"] — first is primary, like asdf fallbacks
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1);
    const first = inner.split(',')[0];
    if (!first) return null;
    return unquoteTomlString(first);
  }
  return unquoteTomlString(t);
}

function parseTomlAssign(stripped) {
  const m = stripped.match(/^([A-Za-z0-9_.:\/-]+|"[^"]+"|'[^']+')\s*=\s*(.+)$/);
  if (!m) return null;
  return { key: unquoteTomlKey(m[1]), value: m[2].trim() };
}

function extractMiseTools(text) {
  const tools = {};
  let section = null;
  let toolsSub = null;
  for (const line of String(text).split(/\r?\n/)) {
    const stripped = stripHashComment(line).trim();
    if (!stripped) continue;
    const hdr = stripped.match(/^\[([^\]]+)\]$/);
    if (hdr) {
      const name = hdr[1].trim();
      if (name === 'tools') {
        section = 'tools';
        toolsSub = null;
      } else if (name.startsWith('tools.')) {
        section = 'tools-sub';
        toolsSub = unquoteTomlKey(name.slice('tools.'.length));
      } else {
        section = null;
        toolsSub = null;
      }
      continue;
    }
    if (section === 'tools') {
      const kv = parseTomlAssign(stripped);
      if (!kv) continue;
      const ver = versionFromTomlValue(kv.value);
      if (ver != null && ver !== '') tools[kv.key] = ver;
    } else if (section === 'tools-sub' && toolsSub) {
      const kv = parseTomlAssign(stripped);
      if (kv && kv.key === 'version') {
        const ver = versionFromTomlValue(kv.value);
        if (ver != null && ver !== '') tools[toolsSub] = ver;
      }
    }
  }
  return tools;
}

function parseMiseToml(file, text, langs) {
  const out = [];
  const tools = extractMiseTools(text);
  for (const [name, raw] of Object.entries(tools)) {
    const lang = TOOL_NAME_TO_LANG[String(name).toLowerCase()];
    if (!lang || !langs.includes(lang)) continue;
    out.push(filePin(lang, file, String(raw), 'mise.toml#tools'));
  }
  return out;
}

function stripJsonc(text) {
  const s = String(text);
  let out = '';
  let i = 0;
  let inStr = false;
  let escape = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      i += 2;
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  // Remove trailing commas outside strings.
  let cleaned = '';
  inStr = false;
  escape = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inStr) {
      cleaned += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cleaned += c;
      continue;
    }
    if (c === ',') {
      let k = j + 1;
      while (k < out.length && /[\s]/.test(out[k])) k += 1;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    cleaned += c;
  }
  return cleaned;
}

function featureLang(featureId) {
  const path = String(featureId).toLowerCase().split(':')[0];
  if (/(^|\/)node$/.test(path)) return 'node';
  if (/(^|\/)python$/.test(path)) return 'python';
  if (/(^|\/)(?:go|golang)$/.test(path)) return 'go';
  if (/(^|\/)rust$/.test(path)) return 'rust';
  return null;
}

/**
 * devcontainer.json `image` and `features` language versions.
 * Feature IDs such as ghcr.io/devcontainers/features/node:1 are the
 * feature package version; the language pin is options.version
 * (Node defaults to "lts" when omitted; Python defaults to "os-provided").
 * https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-features.md
 * https://github.com/devcontainers/features/blob/main/src/node/README.md
 */
function parseDevcontainer(file, text, langs) {
  const out = [];
  let json;
  try {
    json = JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new Error(`Invalid JSONC in ${file}: ${err.message}`);
  }
  if (!json || typeof json !== 'object') return out;

  if (json.image) {
    const decl = imageToDecl(file, 'devcontainer.json#image', json.image, langs);
    if (decl) out.push(decl);
  }

  const features = json.features;
  if (features && typeof features === 'object' && !Array.isArray(features)) {
    for (const [id, options] of Object.entries(features)) {
      const lang = featureLang(id);
      if (!lang || !langs.includes(lang)) continue;
      let raw;
      if (options && typeof options === 'object' && options.version != null && options.version !== '') {
        raw = String(options.version);
      } else if (lang === 'node') {
        raw = 'lts';
      } else if (lang === 'python') {
        raw = 'os-provided';
      } else {
        raw = 'latest';
      }
      out.push(filePin(lang, file, raw, 'devcontainer.json#features'));
    }
  }
  return out;
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
  parseToolVersions,
  parseMiseToml,
  parseDevcontainer,
  isLikelyDockerfile,
  isComposeFile,
  isMiseConfig,
  parsePyproject,
  parseGoMod,
  extractMatrices,
  stripYamlScalar,
  shouldSkipDir,
  isDockerContext,
};
