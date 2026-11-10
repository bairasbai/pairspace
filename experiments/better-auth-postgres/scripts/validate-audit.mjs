import { readFileSync } from 'node:fs';

try {
  const [, , path, rawStatus] = process.argv;
  if (!['0', '1'].includes(rawStatus)) throw new Error(`npm audit operational exit: ${rawStatus}`);
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(report) || report.auditReportVersion !== 2 || 'error' in report
    || !object(report.vulnerabilities) || !object(report.metadata)
    || !object(report.metadata.vulnerabilities) || !object(report.metadata.dependencies)) {
    throw new Error('Missing or invalid npm audit report metadata');
  }
  const counts = report.metadata.vulnerabilities;
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  if (![...severities, 'total'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    || counts.total !== severities.reduce((sum, key) => sum + counts[key], 0)
    || counts.total !== Object.keys(report.vulnerabilities).length) {
    throw new Error('Invalid vulnerability counts');
  }
  const dependencies = report.metadata.dependencies;
  if (!Number.isSafeInteger(dependencies.total) || dependencies.total < 0
    || !Object.values(dependencies).every(count => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error('Invalid dependency metadata');
  }
  if ((rawStatus === '0') !== (counts.total === 0)) {
    throw new Error('Audit exit status disagrees with vulnerability findings');
  }
  console.log(`Validated npm audit: ${counts.total} findings; exit ${rawStatus}. Findings remain a release gate.`);
} catch (error) {
  console.error(`Audit verification failed: ${error.message}`);
  process.exitCode = 1;
}
