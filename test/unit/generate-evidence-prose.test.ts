import { describe, expect, it, vi } from 'vitest';
import type { VersionedAnthropicProvider } from '../../src/modules/contracts/anthropic-provider.js';
import {
  generateEvidenceProse,
  hashEvidenceStatements,
  EVIDENCE_PROSE_PROMPT,
  EVIDENCE_PROSE_SCHEMA_VERSION,
  EvidenceProseError,
  type EvidenceStatementInput,
} from '../../src/modules/disputes/generate-evidence-prose.js';

const statement: EvidenceStatementInput = {
  disputeLineId: 'dl-1',
  amountLabel: '1000.00 USD',
  varianceLabel: '50.00 USD',
  citations: [{ kind: 'clause', reference: 'Section 4.2', page: '12' }],
  criterionKey: 'CONTRACT.RATE_VARIANCE',
};

const goodOutput = {
  schemaVersion: EVIDENCE_PROSE_SCHEMA_VERSION,
  paragraphs: [{ disputeLineId: 'dl-1', paragraph: 'The billed amount exceeds the contracted rate per Section 4.2.', citedReferences: ['Section 4.2'] }],
};

describe('generateEvidenceProse', () => {
  it('accepts prose that cites a supplied reference', async () => {
    const generateStructured = vi.fn().mockResolvedValue({ output: goodOutput, provider: 'anthropic' });
    const result = await generateEvidenceProse({ generateStructured } as unknown as VersionedAnthropicProvider, [statement]);
    expect(result.output).toEqual(goodOutput);
    expect(EVIDENCE_PROSE_PROMPT.system).toMatch(/Never emit arithmetic/);
    expect(EVIDENCE_PROSE_PROMPT.system).toMatch(/Use ONLY the amount, variance, and citation references supplied/);
  });

  it('passes a deterministic sourceDocumentSha256 derived from the statements', async () => {
    const generateStructured = vi.fn().mockResolvedValue({ output: goodOutput, provider: 'anthropic' });
    await generateEvidenceProse({ generateStructured } as unknown as VersionedAnthropicProvider, [statement]);
    expect(generateStructured).toHaveBeenCalledWith(expect.objectContaining({
      sourceDocumentSha256: hashEvidenceStatements([statement]),
    }));
  });

  it('rejects an empty statement set without calling the provider', async () => {
    const generateStructured = vi.fn();
    await expect(generateEvidenceProse({ generateStructured } as unknown as VersionedAnthropicProvider, []))
      .rejects.toBeInstanceOf(EvidenceProseError);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('rejects a paragraph that cites no supplied reference', async () => {
    const uncited = { ...goodOutput, paragraphs: [{ ...goodOutput.paragraphs[0]!, citedReferences: [] }] };
    const generateStructured = vi.fn().mockResolvedValue({ output: uncited, provider: 'anthropic' });
    try {
      await generateEvidenceProse({ generateStructured } as unknown as VersionedAnthropicProvider, [statement]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EvidenceProseError);
      expect((err as EvidenceProseError).code).toBe('UNCITED_PARAGRAPH');
    }
  });

  it('rejects a paragraph that cites a reference not supplied for that line', async () => {
    const fabricated = { ...goodOutput, paragraphs: [{ ...goodOutput.paragraphs[0]!, citedReferences: ['Section 9.9'] }] };
    const generateStructured = vi.fn().mockResolvedValue({ output: fabricated, provider: 'anthropic' });
    await expect(generateEvidenceProse({ generateStructured } as unknown as VersionedAnthropicProvider, [statement]))
      .rejects.toMatchObject({ code: 'UNCITED_PARAGRAPH' });
  });

  it('rejects a paragraph referencing a dispute line that was not supplied', async () => {
    const unknownLine = { ...goodOutput, paragraphs: [{ ...goodOutput.paragraphs[0]!, disputeLineId: 'dl-unknown' }] };
    const generateStructured = vi.fn().mockResolvedValue({ output: unknownLine, provider: 'anthropic' });
    await expect(generateEvidenceProse({ generateStructured } as unknown as VersionedAnthropicProvider, [statement]))
      .rejects.toMatchObject({ code: 'UNKNOWN_LINE' });
  });

  it('preserves prohibited provider fields for explicit money-authority rejection before strict parsing', async () => {
    const unsafe = { ...goodOutput, paragraphs: [{ ...goodOutput.paragraphs[0]!, calculatedAmount: '999.00' }] };
    const generateStructured = vi.fn().mockResolvedValue({ output: unsafe, provider: 'anthropic' });
    await expect(generateEvidenceProse({ generateStructured } as unknown as VersionedAnthropicProvider, [statement]))
      .rejects.toMatchObject({ code: 'MODEL_MONEY_AUTHORITY_REJECTED' });
  });
});

describe('hashEvidenceStatements', () => {
  it('is deterministic for the same statements', () => {
    expect(hashEvidenceStatements([statement])).toBe(hashEvidenceStatements([statement]));
  });

  it('differs when statements differ', () => {
    const other: EvidenceStatementInput = { ...statement, disputeLineId: 'dl-2' };
    expect(hashEvidenceStatements([statement])).not.toBe(hashEvidenceStatements([other]));
  });
});
