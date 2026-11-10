'use strict';

function formatHuman(result) {
  const lines = [];
  const declCount = result.declarations.length;
  lines.push(`RuntimeGate checked ${declCount} declaration${declCount === 1 ? '' : 's'} (${result.langs.join(', ') || 'none'}).`);

  if (result.scanErrors && result.scanErrors.length) {
    lines.push('');
    lines.push('Scan issues:');
    for (const err of result.scanErrors) {
      lines.push(`  - ${err.file}: ${err.message}`);
    }
  }

  if (!result.findings.length) {
    if (declCount === 0) {
      lines.push('No runtime version declarations found.');
    } else {
      lines.push('OK — declared runtimes agree.');
    }
    return lines.join('\n') + '\n';
  }

  const errors = result.findings.filter((f) => f.severity === 'error');
  const warnings = result.findings.filter((f) => f.severity === 'warning');

  if (errors.length) {
    lines.push('');
    lines.push(`Errors (${errors.length}):`);
    for (const f of errors) {
      lines.push(`  [${f.code}] ${f.message}`);
    }
  }
  if (warnings.length) {
    lines.push('');
    lines.push(`Warnings (${warnings.length}):`);
    for (const f of warnings) {
      lines.push(`  [${f.code}] ${f.message}`);
    }
  }
  return lines.join('\n') + '\n';
}

function formatJson(result) {
  return JSON.stringify({
    ok: result.ok,
    langs: result.langs,
    root: result.root,
    declarations: result.declarations,
    findings: result.findings,
    scanErrors: result.scanErrors,
  }, null, 2) + '\n';
}

module.exports = { formatHuman, formatJson };
