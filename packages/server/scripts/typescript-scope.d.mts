export interface TypecheckScopeAnalysis {
  scope: 'source-only' | 'source-and-tests';
  testFilesTypechecked: boolean;
  excludedPatterns: string[];
  unexpectedExclusions: string[];
}

export function analyzeTypecheckScope(config: {
  exclude?: unknown[];
  [key: string]: unknown;
}): TypecheckScopeAnalysis;
export function formatScopeReceipt(analysis: TypecheckScopeAnalysis): string;
export function formatMachineReceipt(analysis: TypecheckScopeAnalysis): string;
export function assertKnownExclusions(analysis: TypecheckScopeAnalysis): void;
export function assertFullCoverage(analysis: TypecheckScopeAnalysis): void;
export function countTestFileErrors(output: string): number;
export function countCompiledTestFiles(output: string): number;
export function assertTestFilesCompiled(fileCount: number): void;
export function assertTestErrorBaseline(errorCount: number): void;
