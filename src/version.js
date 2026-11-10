'use strict';

const { resolveNodeCodename } = require('./eol');

const FLOATING_TAGS = new Set([
  'latest',
  'current',
  'stable',
  'lts',
  'slim',
  'alpine',
  'bullseye',
  'bookworm',
  'trixie',
  'jammy',
  'noble',
]);

/**
 * Strip a leading v and any Debian/Alpine-style image suffix from a tag.
 * "20.11.1-alpine" -> "20.11.1"
 * "v22" -> "22"
 */
function stripTagSuffix(raw) {
  let s = String(raw).trim();
  s = s.replace(/^v/i, '');
  // Drop digest if present
  s = s.split('@')[0];
  // Keep the leading dotted numeric version; drop -alpine, -slim, -bookworm, etc.
  const m = s.match(/^(\d+(?:\.\d+){0,3})(?:[-_].*)?$/);
  if (m) return m[1];
  return s;
}

/**
 * Parse a numeric version like 20, 20.11, 20.11.1, v22.11.0.
 * @returns {{major:number, minor:number|null, patch:number|null, raw:string}|null}
 */
function parseNumericVersion(input) {
  if (input == null) return null;
  const cleaned = stripTagSuffix(input);
  const m = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] !== undefined ? Number(m[2]) : null,
    patch: m[3] !== undefined ? Number(m[3]) : null,
    raw: String(input).trim(),
  };
}

/**
 * Resolve a Node pin, including nvm/n aliases such as lts/iron or lts/*.
 * lts/* cannot be resolved to a single major without a live schedule lookup,
 * so it is returned as { kind: 'alias', alias }.
 */
function parseNodePin(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { kind: 'empty', raw };
  const lower = raw.toLowerCase().replace(/^v/, '');

  if (FLOATING_TAGS.has(lower) || lower === 'lts/*' || lower === 'node') {
    return { kind: 'floating', raw, alias: lower };
  }
  const lts = lower.match(/^lts\/([a-z]+)$/);
  if (lts) {
    const major = resolveNodeCodename(lts[1]);
    if (major == null) return { kind: 'alias', raw, alias: lower };
    return { kind: 'version', raw, major, minor: null, patch: null, alias: lower };
  }

  const ver = parseNumericVersion(raw);
  if (ver) return { kind: 'version', ...ver };
  return { kind: 'unknown', raw };
}

function parsePythonPin(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { kind: 'empty', raw };
  // Heroku-style runtime.txt: python-3.12.1
  const heroku = raw.match(/^python-(\d+(?:\.\d+){0,2})$/i);
  const ver = parseNumericVersion(heroku ? heroku[1] : raw);
  if (ver) return { kind: 'version', ...ver };
  const lower = raw.toLowerCase();
  if (FLOATING_TAGS.has(lower)) return { kind: 'floating', raw, alias: lower };
  return { kind: 'unknown', raw };
}

function parseGoPin(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { kind: 'empty', raw };
  // go1.22.5 or 1.22 or 1.22.5
  const cleaned = raw.replace(/^go/i, '');
  const ver = parseNumericVersion(cleaned);
  if (ver) return { kind: 'version', ...ver };
  const lower = raw.toLowerCase();
  if (FLOATING_TAGS.has(lower)) return { kind: 'floating', raw, alias: lower };
  return { kind: 'unknown', raw };
}

function parsePin(lang, input) {
  if (lang === 'node') return parseNodePin(input);
  if (lang === 'python') return parsePythonPin(input);
  if (lang === 'go') return parseGoPin(input);
  return { kind: 'unknown', raw: String(input) };
}

/** Inclusive min and exclusive-unbounded max for a possibly loose pin. */
function pinBounds(ver) {
  const min = { major: ver.major, minor: ver.minor ?? 0, patch: ver.patch ?? 0 };
  let maxExclusive;
  if (ver.minor == null) {
    maxExclusive = { major: ver.major + 1, minor: 0, patch: 0 };
  } else if (ver.patch == null) {
    maxExclusive = { major: ver.major, minor: ver.minor + 1, patch: 0 };
  } else {
    maxExclusive = { major: ver.major, minor: ver.minor, patch: ver.patch + 1 };
  }
  return { min, maxExclusive };
}

function cmp3(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function formatVer(v) {
  if (v.minor == null) return String(v.major);
  if (v.patch == null) return `${v.major}.${v.minor}`;
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * A tiny engines-style range checker.
 * Supports: exact, >= > <= <, ^, ~, ||, and space/comma-separated AND.
 * Not a complete npm semver implementation (no hyphens, no x-ranges like 20.x,
 * no prerelease tags).
 */
function parseRangeComparator(token) {
  const t = token.trim();
  if (!t) return null;
  const m = t.match(/^(>=|>|<=|<|=|~|\^)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  const op = m[1] || '=';
  const ver = {
    major: Number(m[2]),
    minor: m[3] !== undefined ? Number(m[3]) : 0,
    patch: m[4] !== undefined ? Number(m[4]) : 0,
    origMinor: m[3] !== undefined,
    origPatch: m[4] !== undefined,
  };
  return { op, ver };
}

function splitOr(range) {
  return String(range).split(/\s*\|\|\s*/);
}

function splitAnd(clause) {
  // commas or whitespace
  return clause
    .trim()
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function versionSatisfiesComparators(point, comparators) {
  for (const c of comparators) {
    if (!comparatorHolds(point, c)) return false;
  }
  return true;
}

function comparatorHolds(point, c) {
  const { op, ver } = c;
  if (op === '^') {
    // Compatible with: >=ver <next-breaking, where breaking is major+1
    // if major>0, else minor+1 if minor>0, else patch+1.
    const min = { major: ver.major, minor: ver.minor, patch: ver.patch };
    let max;
    if (ver.major > 0) max = { major: ver.major + 1, minor: 0, patch: 0 };
    else if (ver.minor > 0) max = { major: 0, minor: ver.minor + 1, patch: 0 };
    else max = { major: 0, minor: 0, patch: ver.patch + 1 };
    return cmp3(point, min) >= 0 && cmp3(point, max) < 0;
  }
  if (op === '~') {
    // >=ver <next-minor (if minor specified) else <next-major
    const min = { major: ver.major, minor: ver.minor, patch: ver.patch };
    const max = ver.origMinor
      ? { major: ver.major, minor: ver.minor + 1, patch: 0 }
      : { major: ver.major + 1, minor: 0, patch: 0 };
    return cmp3(point, min) >= 0 && cmp3(point, max) < 0;
  }
  const n = cmp3(point, { major: ver.major, minor: ver.minor, patch: ver.patch });
  if (op === '>=') return n >= 0;
  if (op === '>') return n > 0;
  if (op === '<=') return n <= 0;
  if (op === '<') return n < 0;
  if (op === '=') return n === 0;
  return false;
}

function pointSatisfiesRange(point, rangeText) {
  const orClauses = splitOr(rangeText);
  for (const clause of orClauses) {
    const tokens = splitAnd(clause);
    const comps = [];
    let ok = true;
    for (const tok of tokens) {
      const c = parseRangeComparator(tok);
      if (!c) {
        ok = false;
        break;
      }
      comps.push(c);
    }
    if (ok && comps.length && versionSatisfiesComparators(point, comps)) return true;
  }
  return false;
}

/**
 * A loose pin satisfies a range only if every concrete version it could
 * expand to would satisfy the range.
 */
function pinSatisfiesRange(pin, rangeText) {
  if (pin.kind !== 'version' && pin.kind !== 'pin') return { ok: false, reason: 'unresolved' };
  const { min, maxExclusive } = pinBounds(pin);
  const lo = pointSatisfiesRange(min, rangeText);
  // Test the greatest representable point just below maxExclusive.
  const hiPoint = {
    major: maxExclusive.minor === 0 && maxExclusive.patch === 0
      ? maxExclusive.major - 1
      : maxExclusive.major,
    minor: maxExclusive.patch === 0 && maxExclusive.minor === 0
      ? 9999
      : (maxExclusive.patch === 0 ? maxExclusive.minor - 1 : maxExclusive.minor),
    patch: maxExclusive.patch === 0 ? 9999 : maxExclusive.patch - 1,
  };
  // Simpler high bound: if the pin is exact, min==the version and we only test min.
  if (pin.minor != null && pin.patch != null) {
    return { ok: lo, reason: lo ? null : 'unsatisfied' };
  }
  const hi = pointSatisfiesRange(hiPoint, rangeText);
  if (lo && hi) return { ok: true, reason: null };
  return { ok: false, reason: 'unsatisfied-or-loose' };
}

function rangeLooksValid(rangeText) {
  const orClauses = splitOr(rangeText);
  if (!orClauses.length) return false;
  for (const clause of orClauses) {
    const tokens = splitAnd(clause);
    if (!tokens.length) return false;
    for (const tok of tokens) {
      if (!parseRangeComparator(tok)) return false;
    }
  }
  return true;
}

module.exports = {
  FLOATING_TAGS,
  stripTagSuffix,
  parseNumericVersion,
  parseNodePin,
  parsePythonPin,
  parseGoPin,
  parsePin,
  pinBounds,
  cmp3,
  formatVer,
  pinSatisfiesRange,
  pointSatisfiesRange,
  rangeLooksValid,
};
