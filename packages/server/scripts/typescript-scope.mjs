#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsconfigPath = path.join(packageRoot, 'tsconfig.json');
const KNOWN_EXCLUSIONS = new Set(['src/**/*.test.ts']);
const TEST_ERROR_BASELINE = 48;

export function analyzeTypecheckScope(config) {
  const excludedPatterns = Array.isArray(config.exclude)
    ? config.exclude.map(String)
    : [];
  const unexpectedExclusions = excludedPatterns.filter(
    (pattern) => !KNOWN_EXCLUSIONS.has(pattern),
  );
  const excludesTests = excludedPatterns.includes('src/**/*.test.ts');

  return {
    scope: excludesTests ? 'source-only' : 'source-and-tests',
    testFilesTypechecked: !excludesTests,
    excludedPatterns,
    unexpectedExclusions,
  };
}

export function formatScopeReceipt(analysis) {
  if (analysis.scope === 'source-only') {
    return [
      'TYPECHECK SCOPE: production source only.',
      'TEST FILES: NOT TYPECHECKED (tsconfig excludes src/**/*.test.ts).',
    ].join('\n');
  }

  return 'TYPECHECK SCOPE: production source and test files.';
}

export function formatMachineReceipt(analysis) {
  return `TYPECHECK_RECEIPT=${JSON.stringify({
    scope: analysis.scope,
    test_files_typechecked: analysis.testFilesTypechecked,
    excluded_patterns: analysis.excludedPatterns,
  })}`;
}

export function assertKnownExclusions(analysis) {
  if (analysis.unexpectedExclusions.length > 0) {
    throw new Error(
      `Unexpected tsconfig exclusions: ${analysis.unexpectedExclusions.join(', ')}`,
    );
  }
}

export function assertFullCoverage(analysis) {
  if (analysis.scope !== 'source-and-tests') {
    throw new Error(
      'Full TypeScript coverage is unavailable: test files are excluded. ' +
        'Use `npm run typecheck:source` only when reporting the source-only scope.',
    );
  }
}

export function countTestFileErrors(output) {
  return output
    .split('\n')
    .filter((line) => /\.test\.ts\(\d+,\d+\): error TS\d+:/.test(line))
    .length;
}

export function countCompiledTestFiles(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\.test\.ts$/.test(line))
    .length;
}

export function assertTestFilesCompiled(fileCount) {
  if (fileCount === 0) {
    throw new Error('TypeScript compiled zero test files; test-error count is unknown.');
  }
}

export function assertTestErrorBaseline(errorCount) {
  if (errorCount > TEST_ERROR_BASELINE) {
    throw new Error(
      `Test-file TypeScript errors grew from ${TEST_ERROR_BASELINE} to ${errorCount}.`,
    );
  }
}

function runTsc(tsconfig, extraArgs = []) {
  const require = createRequire(import.meta.url);
  const tscPath = require.resolve('typescript/bin/tsc');
  return spawnSync(process.execPath, [tscPath, '-p', tsconfig, ...extraArgs], {
    encoding: 'utf8',
  });
}

function checkTestErrorBaseline() {
  const temporaryConfig = path.join(packageRoot, `.typecheck-tests-${process.pid}.json`);

  try {
    fs.writeFileSync(
      temporaryConfig,
      `${JSON.stringify({ extends: './tsconfig.json', exclude: [] }, null, 2)}\n`,
    );
    const result = runTsc(temporaryConfig, ['--noEmit', '--pretty', 'false', '--listFiles']);
    if (result.error) throw result.error;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);
    const compiledTestFileCount = countCompiledTestFiles(output);
    const testErrorCount = countTestFileErrors(output);
    process.stderr.write(`TYPECHECK_TEST_BASELINE=${JSON.stringify({
      compiled_test_files: compiledTestFileCount,
      current_test_errors: testErrorCount,
      maximum_test_errors: TEST_ERROR_BASELINE,
      may_grow: false,
      source_errors_asserted: false,
    })}\n`);
    process.stderr.write(
      'SOURCE TYPE STATUS: NOT ASSERTED by this command; run `npm run typecheck:source`.\n',
    );
    assertTestFilesCompiled(compiledTestFileCount);
    assertTestErrorBaseline(testErrorCount);
  } finally {
    fs.rmSync(temporaryConfig, { force: true });
  }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const analysis = analyzeTypecheckScope(loadConfig());
  process.stderr.write(`${formatMachineReceipt(analysis)}\n`);
  process.stderr.write(`${formatScopeReceipt(analysis)}\n`);

  try {
    assertKnownExclusions(analysis);
  } catch (error) {
    process.stderr.write(`REFUSED: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.has('--assert-full')) {
    try {
      assertFullCoverage(analysis);
    } catch (error) {
      process.stderr.write(`REFUSED: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
  }

  if (args.has('--assert-test-baseline')) {
    try {
      checkTestErrorBaseline();
    } catch (error) {
      process.stderr.write(`REFUSED: ${error.message}\n`);
      process.exitCode = 2;
    }
    return;
  }

  const tscArgs = args.has('--emit') ? [] : ['--noEmit'];
  const result = runTsc(tsconfigPath, tscArgs);

  if (result.error) throw result.error;
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
