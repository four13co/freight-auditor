import { Decimal } from 'decimal.js';

export interface VarianceMember { id: string; amount: string; currency: string }
export interface VarianceAttributionRequest {
  level: 'GROUP' | 'INVOICE';
  key: string;
  billed: readonly VarianceMember[];
  expected: readonly VarianceMember[];
}
export interface VarianceAttribution {
  level: 'GROUP' | 'INVOICE'; key: string; currency: string;
  billedIds: string[]; expectedIds: string[];
  billedTotal: string; expectedTotal: string; varianceAmount: string;
  direction: 'OVERCHARGE' | 'UNDERCHARGE' | 'CONFORMED';
}
export interface VarianceAttributionIssue { level: 'GROUP' | 'INVOICE'; key: string; reason: 'MISSING_SIDE' | 'CURRENCY_MISMATCH' }

export function attributeGroupedVariance(requests: readonly VarianceAttributionRequest[]): {
  attributed: VarianceAttribution[]; unassessable: VarianceAttributionIssue[];
} {
  const keys = new Set<string>();
  const memberIds = new Set<string>();
  const attributed: VarianceAttribution[] = [];
  const unassessable: VarianceAttributionIssue[] = [];
  for (const request of [...requests].sort((a, b) => `${a.level}|${a.key}`.localeCompare(`${b.level}|${b.key}`))) {
    const key = request.key.trim();
    if (!key) throw new Error('attribution key is required');
    const scopedKey = `${request.level}|${key}`;
    if (keys.has(scopedKey)) throw new Error(`duplicate attribution key: ${scopedKey}`);
    keys.add(scopedKey);
    if (request.billed.length === 0 || request.expected.length === 0) {
      unassessable.push({ level: request.level, key, reason: 'MISSING_SIDE' });
      continue;
    }
    const all = [...request.billed, ...request.expected];
    const currencies = new Set(all.map((m) => m.currency.trim().toUpperCase()));
    if (currencies.size !== 1 || !/^[A-Z]{3}$/.test([...currencies][0] ?? '')) {
      unassessable.push({ level: request.level, key, reason: 'CURRENCY_MISMATCH' });
      continue;
    }
    for (const member of all) {
      const id = member.id.trim();
      if (!id) throw new Error(`member id is required for ${scopedKey}`);
      if (memberIds.has(id)) throw new Error(`member appears in multiple attributions: ${id}`);
      memberIds.add(id);
    }
    const parse = (member: VarianceMember): Decimal => {
      let value: Decimal;
      try { value = new Decimal(member.amount); } catch { throw new Error(`invalid member amount: ${member.id}`); }
      if (!value.isFinite() || value.isNegative()) throw new Error(`invalid member amount: ${member.id}`);
      return value;
    };
    const billedTotal = request.billed.reduce((sum, member) => sum.plus(parse(member)), new Decimal(0));
    const expectedTotal = request.expected.reduce((sum, member) => sum.plus(parse(member)), new Decimal(0));
    const variance = billedTotal.minus(expectedTotal).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    attributed.push({ level: request.level, key, currency: [...currencies][0]!,
      billedIds: request.billed.map((m) => m.id.trim()).sort(), expectedIds: request.expected.map((m) => m.id.trim()).sort(),
      billedTotal: billedTotal.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
      expectedTotal: expectedTotal.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4), varianceAmount: variance.toFixed(4),
      direction: variance.isPositive() ? 'OVERCHARGE' : variance.isNegative() ? 'UNDERCHARGE' : 'CONFORMED' });
  }
  return { attributed, unassessable };
}
