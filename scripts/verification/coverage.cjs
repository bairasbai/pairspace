'use strict';
const { readFileSync } = require('node:fs');
const path = require('node:path');
const directories = { 'runner-coverage': 'runner-coverage', 'api-domain-coverage': 'api-coverage',
  'mobile-domain-coverage': 'mobile-coverage' };
function coverageResult(id, runtime) {
  if (!directories[id]) return null;
  try {
    const summary = JSON.parse(readFileSync(path.join(runtime, directories[id], 'coverage-summary.json'), 'utf8'));
    const metrics = ['statements', 'branches', 'functions', 'lines'];
    const valid = Object.keys(summary).length > 1 && metrics.every(metric => {
      const value = summary.total?.[metric];
      return value && Number.isFinite(value.total) && value.total > 0
        && Number.isFinite(value.covered) && value.covered <= value.total
        && value.covered / value.total >= 0.9 && Number.isFinite(value.pct) && value.pct >= 90;
    });
    return { valid, total: summary.total, fileCount: Object.keys(summary).length - 1,
      artifact: 'runtime/' + directories[id] + '/coverage-summary.json' };
  } catch { return { valid: false, error: 'COVERAGE_SUMMARY_MISSING_OR_INVALID' }; }
}
module.exports = { coverageResult };
