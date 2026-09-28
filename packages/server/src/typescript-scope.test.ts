import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  analyzeTypecheckScope,
  assertFullCoverage,
  assertKnownExclusions,
  assertTestFilesCompiled,
  assertTestErrorBaseline,
  countCompiledTestFiles,
  countTestFileErrors,
  formatMachineReceipt,
  formatScopeReceipt,
} from '../scripts/typescript-scope.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('TypeScript evidence scope', () => {
  it('makes the package test-file exclusion explicit', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'tsconfig.json'), 'utf8'),
    );

    const analysis = analyzeTypecheckScope(config);

    expect(analysis.scope).toBe('source-only');
    expect(formatScopeReceipt(analysis)).toContain('TEST FILES: NOT TYPECHECKED');
    const receipt = JSON.parse(
      formatMachineReceipt(analysis).replace('TYPECHECK_RECEIPT=', ''),
    );
    expect(receipt).toEqual({
      scope: 'source-only',
      test_files_typechecked: false,
      excluded_patterns: ['src/**/*.test.ts'],
    });
    expect(() => assertKnownExclusions(analysis)).not.toThrow();
    expect(() => assertFullCoverage(analysis)).toThrow(
      'Full TypeScript coverage is unavailable',
    );
  });

  it('recognizes a configuration that includes tests', () => {
    const analysis = analyzeTypecheckScope({ include: ['src'] });

    expect(analysis.scope).toBe('source-and-tests');
    expect(formatScopeReceipt(analysis)).toBe(
      'TYPECHECK SCOPE: production source and test files.',
    );
    expect(() => assertFullCoverage(analysis)).not.toThrow();
  });

  it('refuses every newly excluded path', () => {
    const analysis = analyzeTypecheckScope({
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/routes/**'],
    });

    expect(analysis.unexpectedExclusions).toEqual(['src/routes/**']);
    expect(() => assertKnownExclusions(analysis)).toThrow(
      'Unexpected tsconfig exclusions: src/routes/**',
    );
  });

  it('routes official build and typecheck commands through the scope guard', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts.build).toBe(
      'node scripts/typescript-scope.mjs --emit',
    );
    expect(packageJson.scripts.typecheck).toBe(
      'node scripts/typescript-scope.mjs --assert-full',
    );
    expect(packageJson.scripts['typecheck:source']).toBe(
      'node scripts/typescript-scope.mjs',
    );
    expect(packageJson.scripts['typecheck:tests']).toBe(
      'node scripts/typescript-scope.mjs --assert-test-baseline',
    );
  });

  it('quarantines the 48 existing test-file errors and refuses growth', () => {
    const existing = Array.from(
      { length: 48 },
      (_, index) => `src/example-${index}.test.ts(1,1): error TS2322: existing`,
    ).join('\n');
    const newError = 'src/new.test.ts(2,3): error TS2345: new regression';

    expect(countTestFileErrors(existing)).toBe(48);
    expect(() => assertTestErrorBaseline(countTestFileErrors(existing))).not.toThrow();
    expect(() =>
      assertTestErrorBaseline(countTestFileErrors(`${existing}\n${newError}`)),
    ).toThrow('Test-file TypeScript errors grew from 48 to 49');
  });

  it('refuses to interpret zero compiled test files as zero test errors', () => {
    const listedFiles = [
      '/repo/src/service.ts',
      '/repo/src/service.test.ts',
      '/repo/src/another.test.ts',
    ].join('\n');

    expect(countCompiledTestFiles(listedFiles)).toBe(2);
    expect(() => assertTestFilesCompiled(2)).not.toThrow();
    expect(countCompiledTestFiles('error TS18003: No inputs were found')).toBe(0);
    expect(() => assertTestFilesCompiled(0)).toThrow(
      'TypeScript compiled zero test files; test-error count is unknown.',
    );
  });
});
