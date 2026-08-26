/** Tier 1 is deliberately conservative: exact one-to-one category/currency only. */
export interface BilledChargeForAlignment { chargeFactId: string; category?: string | null; currency?: string | null }
export interface ExpectedChargeForAlignment { expectedChargeId: string; category?: string | null; currency?: string | null }
export interface Tier1Alignment { key: string; category: string; currency: string; chargeFactId: string; expectedChargeId: string }
export interface AlignmentIssue {
  key: string;
  reason: 'MISSING_CLASSIFICATION' | 'BILLED_ONLY' | 'EXPECTED_ONLY' | 'AMBIGUOUS';
  chargeFactIds: string[];
  expectedChargeIds: string[];
}
export interface Tier1AlignmentResult { alignments: Tier1Alignment[]; unassessable: AlignmentIssue[] }
type Member = { side: 'billed' | 'expected'; id: string };

const canonicalKey = (category?: string | null, currency?: string | null) => {
  const canonicalCategory = category?.trim().toUpperCase() ?? '';
  const canonicalCurrency = currency?.trim().toUpperCase() ?? '';
  return canonicalCategory && /^[A-Z]{3}$/.test(canonicalCurrency)
    ? { key: `${canonicalCategory}|${canonicalCurrency}`, category: canonicalCategory, currency: canonicalCurrency } : null;
};

export function alignTier1Charges(
  billed: readonly BilledChargeForAlignment[], expected: readonly ExpectedChargeForAlignment[],
): Tier1AlignmentResult {
  const ids = new Set<string>();
  const buckets = new Map<string, { category: string; currency: string; members: Member[] }>();
  const missing: AlignmentIssue[] = [];
  const add = (side: Member['side'], id: string, category?: string | null, currency?: string | null): void => {
    const cleanId = id.trim();
    if (!cleanId) throw new Error(`${side} charge id is required`);
    const scopedId = `${side}:${cleanId}`;
    if (ids.has(scopedId)) throw new Error(`duplicate ${side} charge id: ${cleanId}`);
    ids.add(scopedId);
    const canonical = canonicalKey(category, currency);
    if (!canonical) {
      missing.push({ key: scopedId, reason: 'MISSING_CLASSIFICATION',
        chargeFactIds: side === 'billed' ? [cleanId] : [], expectedChargeIds: side === 'expected' ? [cleanId] : [] });
      return;
    }
    const bucket = buckets.get(canonical.key) ?? { ...canonical, members: [] };
    bucket.members.push({ side, id: cleanId });
    buckets.set(canonical.key, bucket);
  };
  billed.forEach((row) => add('billed', row.chargeFactId, row.category, row.currency));
  expected.forEach((row) => add('expected', row.expectedChargeId, row.category, row.currency));

  const alignments: Tier1Alignment[] = [];
  const unassessable = [...missing];
  for (const [key, bucket] of [...buckets].sort(([a], [b]) => a.localeCompare(b))) {
    const chargeFactIds = bucket.members.filter((m) => m.side === 'billed').map((m) => m.id).sort();
    const expectedChargeIds = bucket.members.filter((m) => m.side === 'expected').map((m) => m.id).sort();
    if (chargeFactIds.length === 1 && expectedChargeIds.length === 1) {
      alignments.push({ key, category: bucket.category, currency: bucket.currency,
        chargeFactId: chargeFactIds[0]!, expectedChargeId: expectedChargeIds[0]! });
    } else {
      const reason = chargeFactIds.length === 0 ? 'EXPECTED_ONLY'
        : expectedChargeIds.length === 0 ? 'BILLED_ONLY' : 'AMBIGUOUS';
      unassessable.push({ key, reason, chargeFactIds, expectedChargeIds });
    }
  }
  return { alignments, unassessable: unassessable.sort((a, b) => a.key.localeCompare(b.key)) };
}
