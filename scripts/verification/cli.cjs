#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { plan } = require('./profile.cjs');
const { verify } = require('./runner.cjs');
async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--plan', '--runner'].includes(arg)) || new Set(args).size !== args.length) {
    console.error('Usage: node scripts/verification/cli.cjs [--plan] [--runner]');
    return 2;
  }
  const root = path.resolve(__dirname, '../..');
  const profile = args.includes('--runner') ? 'runner' : 'full';
  if (args.includes('--plan')) {
    console.log(JSON.stringify({ profile, acceptance: false,
      steps: plan(root, '<fresh-isolated-runtime>', profile) }, null, 2));
    return 0;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const result = await verify({ root, profile, signal: controller.signal,
      onStep: (id, status) => console.log(`${id}: ${status}`) });
    console.log(`${result.report.status}: ${path.join(result.directory, 'report.json')}`);
    return result.exitCode;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
module.exports = { main };
