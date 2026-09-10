import { createHash } from 'node:crypto';
import { canonicalJson } from '../audit-ledger/replay-manifest.js';

export interface GoldenCorpusCase<TInput = unknown, TExpected = unknown> { id: string; input: TInput; expected: TExpected }
export interface GoldenCaseResult { id: string; passed: boolean; inputHash: string; expectedHash: string; actualHash: string; actual: unknown }
export interface GoldenCorpusResult { corpusHash: string; passed: boolean; passCount: number; regressionCount: number; cases: GoldenCaseResult[] }
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

export async function runGoldenCorpus<TInput, TExpected>(
  cases: readonly GoldenCorpusCase<TInput, TExpected>[], evaluate: (input: TInput) => TExpected | Promise<TExpected>,
): Promise<GoldenCorpusResult> {
  const ids = new Set<string>();
  for (const item of cases) {
    if (!item.id.trim()) throw new Error('golden corpus case id is required');
    if (ids.has(item.id)) throw new Error(`duplicate golden corpus case: ${item.id}`);
    ids.add(item.id);
  }
  const ordered = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  const results: GoldenCaseResult[] = [];
  for (const item of ordered) {
    const actual = await evaluate(item.input);
    const expectedHash = hash(item.expected);
    const actualHash = hash(actual);
    results.push({ id: item.id, passed: expectedHash === actualHash, inputHash: hash(item.input), expectedHash, actualHash, actual });
  }
  const regressionCount = results.filter((r) => !r.passed).length;
  return { corpusHash: hash(ordered.map((c) => ({ id: c.id, inputHash: hash(c.input), expectedHash: hash(c.expected) }))),
    passed: regressionCount === 0, passCount: results.length - regressionCount, regressionCount, cases: results };
}
