'use strict';

const { formatVer, pinSatisfiesRange, rangeLooksValid } = require('./version');
const { eolInfo } = require('./eol');

const SEV_ERROR = 'error';
const SEV_WARNING = 'warning';

/**
 * Turn collected declarations into findings.
 */
function analyze(collected, options = {}) {
  const checkEol = Boolean(options.eol);
  const now = options.now || new Date();
  const findings = [];
  const byLang = groupBy(collected.declarations, (d) => d.lang);

  for (const [lang, decls] of Object.entries(byLang)) {
    findings.push(...analyzeLang(lang, decls, { checkEol, now }));
  }

  const errors = findings.filter((f) => f.severity === SEV_ERROR);
  const warnings = findings.filter((f) => f.severity === SEV_WARNING);

  return {
    ok: errors.length === 0,
    findings,
    errors,
    warnings,
    declarations: collected.declarations,
    scanErrors: collected.errors,
    langs: collected.langs,
    root: collected.root,
  };
}

function analyzeLang(lang, decls, { checkEol, now }) {
  const findings = [];
  const pins = decls.filter((d) => d.kind === 'pin' && !d.matrix);
  const matrixPins = decls.filter((d) => d.kind === 'pin' && d.matrix);
  const ranges = decls.filter((d) => d.kind === 'range');
  const versionFileRefs = decls.filter((d) => d.kind === 'version-file-ref');

  // 1. Pin vs pin series mismatch (non-matrix pins only).
  // Node.js compatibility is the major (20 vs 22). Python and Go compatibility
  // is the major.minor series (3.11 vs 3.12, 1.25 vs 1.27).
  if (pins.length >= 2) {
    const seriesPins = pins.filter((p) => seriesPrecisionOk(lang, p));
    const series = unique(seriesPins.map((p) => seriesKey(lang, p)));
    if (series.length > 1) {
      findings.push({
        severity: SEV_ERROR,
        code: lang === 'node' ? 'major-mismatch' : 'series-mismatch',
        lang,
        message: `${displayLang(lang)} pins disagree on the ${seriesLabel(lang)} (${series.sort().join(' vs ')}).`,
        declarations: seriesPins,
      });
    } else if (series.length === 1) {
      const withPatch = pins.filter((p) => p.patch != null);
      const patches = unique(withPatch.map((p) => `${seriesKey(lang, p)}.${p.patch}`));
      if (withPatch.length >= 2 && patches.length > 1) {
        findings.push({
          severity: SEV_WARNING,
          code: 'patch-mismatch',
          lang,
          message: `${displayLang(lang)} pins agree on ${series[0]} but disagree on patch (${formatDeclList(withPatch)}).`,
          declarations: withPatch,
        });
      }
    }
  }

  // Loose major-only pin next to a more precise pin.
  if (pins.some((p) => p.minor == null) && pins.some((p) => p.minor != null)) {
    const loose = pins.filter((p) => p.minor == null);
    findings.push({
      severity: SEV_WARNING,
      code: 'loose-pin',
      lang,
      message: `Some ${displayLang(lang)} pins are major-only (${formatDeclList(loose)}) while others pin a minor or patch. A major-only tag can float.`,
      declarations: loose,
    });
  }

  // 2. Pins (including matrix entries) vs declared ranges.
  for (const range of ranges) {
    if (!rangeLooksValid(range.raw)) {
      findings.push({
        severity: SEV_WARNING,
        code: 'unparsed-range',
        lang,
        message: `Could not parse ${range.source} range "${range.raw}" in ${range.file}. RuntimeGate supports a subset of engines-style ranges.`,
        declarations: [range],
      });
      continue;
    }
    const toCheck = pins.concat(matrixPins);
    for (const pin of toCheck) {
      const result = pinSatisfiesRange(pin, range.raw);
      if (!result.ok) {
        findings.push({
          severity: SEV_ERROR,
          code: 'range-unsatisfied',
          lang,
          message: `${describePin(pin)} cannot satisfy ${range.source} "${range.raw}" in ${range.file}.`,
          declarations: [pin, range],
        });
      }
    }
  }

  // 3. Range present but no pins at all (except version-file refs).
  if (ranges.length && pins.length === 0 && matrixPins.length === 0) {
    findings.push({
      severity: SEV_WARNING,
      code: 'range-without-pin',
      lang,
      message: `${displayLang(lang)} has a version range (${ranges.map((r) => r.source).join(', ')}) but no concrete pin was found in a version file, Dockerfile, or CI workflow.`,
      declarations: ranges,
    });
  }

  // 4. Hardcoded CI version while a version-file is also referenced, or a
  //    version file exists in the repo. Suggestion only when they already agree.
  const hardcodedCi = pins.filter((p) => /^actions\/setup-/.test(p.source) && !p.matrix);
  const localVersionFiles = pins.filter((p) =>
    p.source === '.nvmrc' ||
    p.source === '.node-version' ||
    p.source === '.python-version' ||
    p.source === 'runtime.txt' ||
    p.source === '.tool-versions'
  );
  if (hardcodedCi.length && (localVersionFiles.length || versionFileRefs.length)) {
    findings.push({
      severity: SEV_WARNING,
      code: 'hardcoded-ci',
      lang,
      message: `${displayLang(lang)} CI hardcodes a version (${formatDeclList(hardcodedCi)}) while a version file is present or referenced. Prefer node-version-file / python-version-file / go-version-file so CI cannot drift.`,
      declarations: hardcodedCi.concat(localVersionFiles, versionFileRefs),
    });
  }

  // 5. Unresolved / floating / interpolation.
  for (const d of decls) {
    if (d.kind === 'floating') {
      findings.push({
        severity: SEV_WARNING,
        code: 'floating-tag',
        lang,
        message: `${d.source} in ${d.file} uses floating tag "${d.raw}", which can move.`,
        declarations: [d],
      });
    } else if (d.kind === 'interpolation') {
      findings.push({
        severity: SEV_WARNING,
        code: 'unresolved-interpolation',
        lang,
        message: `${d.source} in ${d.file} interpolates "${d.raw}", which RuntimeGate cannot resolve.`,
        declarations: [d],
      });
    } else if (d.kind === 'alias' || d.kind === 'unknown') {
      findings.push({
        severity: SEV_WARNING,
        code: 'unresolved-pin',
        lang,
        message: `${d.source} in ${d.file} has pin "${d.raw}" that RuntimeGate could not resolve to a version.`,
        declarations: [d],
      });
    } else if (d.kind === 'matrix-unresolved') {
      findings.push({
        severity: SEV_WARNING,
        code: 'unresolved-matrix',
        lang,
        message: `${d.source} in ${d.file} references ${d.raw}, but the matrix values could not be parsed.`,
        declarations: [d],
      });
    }
  }

  // 6. EOL (opt-in).
  if (checkEol) {
    const allPins = pins.concat(matrixPins);
    const seen = new Set();
    for (const pin of allPins) {
      const key = `${pin.major}.${pin.minor}.${pin.file}.${pin.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const info = eolInfo(lang, pin, now);
      if (info.note && !info.eol) {
        findings.push({
          severity: SEV_WARNING,
          code: 'eol-unknown',
          lang,
          message: `${describePin(pin)}: ${info.note}`,
          declarations: [pin],
        });
      } else if (info.eol) {
        findings.push({
          severity: SEV_ERROR,
          code: 'eol',
          lang,
          message: `${describePin(pin)} is past end of support${info.end ? ` (ended ${info.end})` : ''}${info.note ? `. ${info.note}` : ''}.`,
          declarations: [pin],
        });
      }
    }
  }

  return findings;
}

function describePin(pin) {
  const ver = pin.kind === 'pin' ? formatVer(pin) : pin.raw;
  return `${pin.source} in ${pin.file} (${ver})`;
}

function formatDeclList(decls) {
  return decls.map((d) => `${d.source}@${d.file}:${d.raw}`).join(', ');
}

function displayLang(lang) {
  if (lang === 'node') return 'Node.js';
  if (lang === 'python') return 'Python';
  if (lang === 'go') return 'Go';
  return lang;
}


function seriesPrecisionOk(lang, pin) {
  if (lang === 'node') return pin.major != null;
  return pin.major != null && pin.minor != null;
}

function seriesKey(lang, pin) {
  if (lang === 'node') return String(pin.major);
  return `${pin.major}.${pin.minor}`;
}

function seriesLabel(lang) {
  return lang === 'node' ? 'major version' : 'major.minor series';
}

function unique(arr) {
  return [...new Set(arr)];
}

function groupBy(arr, fn) {
  const out = {};
  for (const item of arr) {
    const k = fn(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

module.exports = { analyze, SEV_ERROR, SEV_WARNING };
