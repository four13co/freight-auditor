import { describe, expect, it } from 'vitest';
import { runGoldenCorpus } from '../../src/modules/rule-engine/golden-corpus-runner.js';

describe('runGoldenCorpus', () => {
  it('is order-independent and identifies exact regressions', async () => {
    const cases = [{ id: 'b', input: 2, expected: 4 }, { id: 'a', input: 1, expected: 3 }];
    const result = await runGoldenCorpus(cases, (n) => n * 2);
    expect(result.cases.map((c) => [c.id, c.passed])).toEqual([['a', false], ['b', true]]);
    expect(result).toMatchObject({ passed: false, passCount: 1, regressionCount: 1 });
    expect((await runGoldenCorpus([...cases].reverse(), (n) => n * 2)).corpusHash).toBe(result.corpusHash);
  });
  it('rejects missing and duplicate identities before evaluation', async () => {
    await expect(runGoldenCorpus([{ id: '', input: 1, expected: 1 }], (n) => n)).rejects.toThrow('id is required');
    await expect(runGoldenCorpus([{ id: 'x', input: 1, expected: 1 }, { id: 'x', input: 2, expected: 2 }], (n) => n)).rejects.toThrow('duplicate golden');
  });
  it('canonicalizes object key ordering', async () => {
    const result = await runGoldenCorpus([{ id: 'x', input: 1, expected: { a: 1, b: 2 } }], () => ({ b: 2, a: 1 }));
    expect(result.passed).toBe(true);
  });
});
