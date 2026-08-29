import { z } from 'zod';

/**
 * Computes a claim's aging deadline (P5.B.1): openedAt plus a configurable
 * number of days. Pure date arithmetic only -- deciding WHAT happens when
 * the deadline passes (follow-up jobs, P5.B.2; escalation, P5.B.3) is
 * later work; this only computes the timestamp itself.
 *
 * agingDays defaults to 30 -- no existing config (client_payment_policy,
 * #161) carries a claim-aging-specific duration, so this follows the same
 * "accept as a parameter with a sane default" pattern this session used
 * for holdThenApprove/shortPayEnabled once a config table exists to source
 * a per-client override from.
 */
const schema = z.object({
  openedAt: z.iso.datetime({ offset: true }).or(z.date()),
  agingDays: z.number().int().positive().max(3650).default(30),
});

export function computeClaimAgingDeadline(untrusted: z.input<typeof schema>): Date {
  const input = schema.parse(untrusted);
  const openedAt = input.openedAt instanceof Date ? input.openedAt : new Date(input.openedAt);
  const deadline = new Date(openedAt);
  deadline.setUTCDate(deadline.getUTCDate() + input.agingDays);
  return deadline;
}
