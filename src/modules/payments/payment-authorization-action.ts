/**
 * Payment authorization action mapping (P4.B.5). Deliberately does not
 * include 'do_not_pay' here -- that decision is system-generated from a
 * gate failure (P4.B.4, generateDoNotPayDecision), never an analyst POST.
 * This surface is analyst-authored authorization only: approve or hold.
 *
 * "Payment defaults remain hold-then-approve" / "no automatic payment
 * approval": every write through this action mapping requires a real
 * actorUserId from an authenticated request (never a system actor) --
 * enforced at the route layer (paymentRoutes.ts), not here, since this
 * module has no access to the request.
 */
export const PAYMENT_AUTHORIZATION_ACTIONS = { approve: 'approve', hold: 'hold' } as const;
export type PaymentAuthorizationAction = keyof typeof PAYMENT_AUTHORIZATION_ACTIONS;

export function isPaymentAuthorizationAction(value: unknown): value is PaymentAuthorizationAction {
  return typeof value === 'string' && value in PAYMENT_AUTHORIZATION_ACTIONS;
}
