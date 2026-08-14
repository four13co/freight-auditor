/** Formats a pg numeric string (e.g. "1876.4000") as "$1,876.40". Returns "—" for null. */
export function formatMoney(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Formats a variance amount with its sign, e.g. "+$1,876.40" / "-$234.90". Returns "n/a" for null. */
export function formatVariance(value: string | null): string {
  if (value === null) return 'n/a';
  const n = Number(value);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`;
}

/** Formats an ISO timestamp as a whole-day age string, e.g. "3d" / "0d" (today). */
export function formatAge(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  const days = Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)));
  return `${days}d`;
}
