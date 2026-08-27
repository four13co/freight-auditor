export type MoneyAuthorityRejectionCode = 'ARITHMETIC_AST' | 'MONEY_LITERAL' | 'AUTHORITATIVE_FINANCIAL_FIELD';

export interface MoneyAuthorityRejection {
  code: MoneyAuthorityRejectionCode;
  path: string;
}

export interface MoneyAuthorityGateResult {
  accepted: boolean;
  rejections: MoneyAuthorityRejection[];
}

const authoritativeKeys = new Set([
  'amount', 'approvedamount', 'billedtotal', 'calculatedamount', 'calculatedtotal', 'expectedamount', 'expectedcharge',
  'expectedtotal', 'invoicepayableamount', 'payableamount', 'paymentamount', 'ratecalculation', 'subtotal',
  'total', 'varianceamount',
]);

/** Recursively detects model output that attempts to become a financial authority. */
export function validateNoModelMoneyAuthority(untrusted: unknown): MoneyAuthorityGateResult {
  const rejections: MoneyAuthorityRejection[] = [];
  visit(untrusted, '$', rejections);
  return { accepted: rejections.length === 0, rejections };
}

export class ModelMoneyAuthorityError extends Error {
  readonly code = 'MODEL_MONEY_AUTHORITY_REJECTED';
  constructor(readonly rejections: MoneyAuthorityRejection[]) {
    super('model output attempted an authoritative money calculation'); this.name = 'ModelMoneyAuthorityError';
  }
}

export function rejectModelMoneyAuthority(untrusted: unknown): void {
  const result = validateNoModelMoneyAuthority(untrusted);
  if (!result.accepted) throw new ModelMoneyAuthorityError(result.rejections);
}

function visit(value: unknown, path: string, rejections: MoneyAuthorityRejection[]): void {
  if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`, rejections)); return; }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.type === 'arith') rejections.push({ code: 'ARITHMETIC_AST', path });
  const isMoneyLiteral = record.type === 'money';
  if (isMoneyLiteral) rejections.push({ code: 'MONEY_LITERAL', path });
  for (const key of Object.keys(record).sort()) {
    const childPath = `${path}.${key}`;
    if (!(isMoneyLiteral && key === 'amount') && authoritativeKeys.has(canonicalKey(key))) {
      rejections.push({ code: 'AUTHORITATIVE_FINANCIAL_FIELD', path: childPath });
    }
    visit(record[key], childPath, rejections);
  }
}

function canonicalKey(key: string): string { return key.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, ''); }
