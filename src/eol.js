'use strict';

/**
 * Vendored end-of-life / support data.
 *
 * Snapshot date: 2026-11-10 (America/New_York).
 * Do not treat this table as a live feed — bump it when cutting a release.
 *
 * Sources (fetched 2026-11-10):
 * - Node.js: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
 *   (`end` is the official end date). Codenames come from the same file.
 * - Python: https://devguide.python.org/versions/
 *   Exact day is used when the table provides one. Month-only dates
 *   (e.g. "2027-10") are stored as the last day of that month; that convention
 *   is ours, not an official day published by the PSF.
 * - Go: https://go.dev/doc/devel/release
 *   Official policy: each major release is supported until there are two
 *   newer major releases. As of this snapshot the latest major is 1.27
 *   (released 2026-08-19), so 1.26 and 1.27 are supported and 1.25 became
 *   unsupported on 2026-08-19.
 */

const SNAPSHOT_DATE = '2026-11-10';

const NODE_SCHEDULE = {
  4: { end: '2018-04-30', codename: 'Argon' },
  5: { end: '2016-06-30' },
  6: { end: '2019-04-30', codename: 'Boron' },
  7: { end: '2017-06-30' },
  8: { end: '2019-12-31', codename: 'Carbon' },
  9: { end: '2018-06-30' },
  10: { end: '2021-04-30', codename: 'Dubnium' },
  11: { end: '2019-06-01' },
  12: { end: '2022-04-30', codename: 'Erbium' },
  13: { end: '2020-06-01' },
  14: { end: '2023-04-30', codename: 'Fermium' },
  15: { end: '2021-06-01' },
  16: { end: '2023-09-11', codename: 'Gallium' },
  17: { end: '2022-06-01' },
  18: { end: '2025-04-30', codename: 'Hydrogen' },
  19: { end: '2023-06-01' },
  20: { end: '2026-04-30', codename: 'Iron' },
  21: { end: '2024-06-01' },
  22: { end: '2027-04-30', codename: 'Jod' },
  23: { end: '2025-06-01' },
  24: { end: '2028-04-30', codename: 'Krypton' },
  25: { end: '2026-06-01' },
  26: { end: '2029-04-30', codename: 'Lithium' },
  27: { end: '2030-04-30' },
};

const PYTHON_EOL = {
  2: { 7: '2020-01-01' },
  3: {
    6: '2021-12-23',
    7: '2023-06-27',
    8: '2024-10-07',
    9: '2025-10-31',
    10: '2026-10-01',
    11: '2027-10-31', // official table: 2027-10 (month only)
    12: '2028-10-31',
    13: '2029-10-31',
    14: '2030-10-31',
    15: '2031-10-31',
    16: '2032-10-31',
  },
};

const GO_POLICY = {
  snapshotDate: SNAPSHOT_DATE,
  source: 'https://go.dev/doc/devel/release',
  latestMajorMinor: '1.27',
  latestMajorReleased: '2026-08-19',
  supportedMajorMinors: ['1.26', '1.27'],
  // 1.25 left support when 1.27.0 was released.
  unsupportedFrom: { '1.25': '2026-08-19' },
};

const NODE_CODENAME_TO_MAJOR = {};
for (const [major, info] of Object.entries(NODE_SCHEDULE)) {
  if (info.codename) {
    NODE_CODENAME_TO_MAJOR[info.codename.toLowerCase()] = Number(major);
  }
}

function parseIsoDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function startOfUtcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * @param {'node'|'python'|'go'} lang
 * @param {{major:number, minor:?number}} ver
 * @param {Date} now
 * @returns {{eol: boolean, end: string|null, note: string|null}}
 */
function eolInfo(lang, ver, now) {
  const today = startOfUtcDay(now);
  if (lang === 'node') {
    const row = NODE_SCHEDULE[ver.major];
    if (!row) return { eol: false, end: null, note: `No vendored Node.js schedule entry for major ${ver.major}.` };
    const end = row.end;
    return { eol: today > parseIsoDate(end), end, note: null };
  }
  if (lang === 'python') {
    const series = PYTHON_EOL[ver.major];
    if (!series) return { eol: false, end: null, note: `No vendored Python schedule entry for ${ver.major}.` };
    if (ver.minor == null) {
      // A major-only pin (rare) cannot be classified without a minor.
      return { eol: false, end: null, note: `Python pin names only major ${ver.major}; minor is required for an EOL check.` };
    }
    const end = series[ver.minor];
    if (!end) return { eol: false, end: null, note: `No vendored Python schedule entry for ${ver.major}.${ver.minor}.` };
    return { eol: today > parseIsoDate(end), end, note: null };
  }
  if (lang === 'go') {
    const key = ver.minor == null ? `${ver.major}` : `${ver.major}.${ver.minor}`;
    // Go support is keyed on major.minor (1.25, 1.26, …).
    if (ver.minor == null) {
      return { eol: false, end: null, note: `Go pin names only major ${ver.major}; minor is required for a support check.` };
    }
    if (GO_POLICY.supportedMajorMinors.includes(key)) {
      return { eol: false, end: null, note: null };
    }
    const oldestSupported = GO_POLICY.supportedMajorMinors.slice().sort(cmpMajorMinor)[0];
    if (cmpMajorMinor(key, oldestSupported) < 0) {
      const from = GO_POLICY.unsupportedFrom[key] || GO_POLICY.latestMajorReleased;
      return {
        eol: today > parseIsoDate(from),
        end: from,
        note: `Per Go's two-major policy, only ${GO_POLICY.supportedMajorMinors.join(' and ')} are supported as of snapshot ${GO_POLICY.snapshotDate}.`,
      };
    }
    return {
      eol: false,
      end: null,
      note: `Go ${key} is newer than the vendored latest (${GO_POLICY.latestMajorMinor}); support data may be stale.`,
    };
  }
  return { eol: false, end: null, note: null };
}

function resolveNodeCodename(name) {
  if (!name) return null;
  return NODE_CODENAME_TO_MAJOR[String(name).toLowerCase()] || null;
}


function cmpMajorMinor(a, b) {
  const as = String(a).split('.').map(Number);
  const bs = String(b).split('.').map(Number);
  const am = as[0] || 0;
  const ai = as[1] || 0;
  const bm = bs[0] || 0;
  const bi = bs[1] || 0;
  if (am !== bm) return am - bm;
  return ai - bi;
}

module.exports = {
  SNAPSHOT_DATE,
  NODE_SCHEDULE,
  PYTHON_EOL,
  GO_POLICY,
  eolInfo,
  resolveNodeCodename,
};
