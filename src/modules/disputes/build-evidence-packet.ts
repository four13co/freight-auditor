import type pg from 'pg';
import { getDefensibilityChain, type DefensibilityChain } from '../findings/get-defensibility-chain.js';

export interface ComputationTraceStep {
  stepOrder: number;
  step: unknown;
  pinnedInputs: unknown;
  clauseId: string | null;
}

export interface EvidencePacketLine {
  disputeLineId: string;
  varianceFindingId: string;
  amount: string | null;
  currency: string | null;
  defensibilityChain: DefensibilityChain;
  computationTrace: ComputationTraceStep[];
}

export interface EvidencePacket {
  disputeId: string;
  lines: EvidencePacketLine[];
}

export class BuildEvidencePacketError extends Error {
  constructor(readonly code: 'DISPUTE_NOT_FOUND' | 'INCOMPLETE_EVIDENCE') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'BuildEvidencePacketError';
  }
}

/**
 * Assembles a deterministic evidence packet for a dispute (P4.C.3): every
 * dispute_line's variance_finding, joined out to its full defensibility
 * chain (criterion, rule version, clause/rate-cell citation, source
 * document -- getDefensibilityChain.ts, unchanged) plus its audit run's
 * computation_trace steps in step_order.
 *
 * Deliberately NOT persisted: everything here is derivable from existing
 * append-only/immutable tables (variance_finding's evidentiary columns
 * never change after write, computation_trace is append-only), so storing
 * a snapshot would only risk drifting from the source of truth it's meant
 * to represent. "Deterministic" means re-running this against the same
 * dispute_line/variance_finding/computation_trace rows always produces the
 * same packet -- not that the packet is cached.
 *
 * No prose, no AI, no injected amounts beyond what the chain already
 * carries -- generating Claude-authored narrative around this evidence
 * (P4.C.5) and injecting stored amounts/calculations into that narrative
 * (P4.C.4) are both later items building ON TOP of this packet's output,
 * not part of it.
 *
 * Ordered by dispute_line.id for determinism (never query/insertion order).
 */
export async function buildEvidencePacket(
  client: pg.PoolClient,
  clientId: string,
  disputeId: string,
): Promise<EvidencePacket> {
  const disputeCheck = await client.query<{ id: string }>(
    `SELECT id FROM dispute WHERE client_id = $1 AND id = $2`,
    [clientId, disputeId],
  );
  if (!disputeCheck.rowCount) throw new BuildEvidencePacketError('DISPUTE_NOT_FOUND');

  const { rows: lineRows } = await client.query<{
    id: string; variance_finding_id: string | null; amount: string | null; currency: string | null;
  }>(
    `SELECT id, variance_finding_id, amount, currency
       FROM dispute_line
      WHERE client_id = $1 AND dispute_id = $2
      ORDER BY id`,
    [clientId, disputeId],
  );

  const lines: EvidencePacketLine[] = [];
  for (const lineRow of lineRows) {
    if (!lineRow.variance_finding_id) throw new BuildEvidencePacketError('INCOMPLETE_EVIDENCE');

    const chain = await getDefensibilityChain(client, clientId, lineRow.variance_finding_id);
    if (!chain) throw new BuildEvidencePacketError('INCOMPLETE_EVIDENCE');

    const { rows: traceRows } = await client.query<{
      step_order: number; step: unknown; pinned_inputs: unknown; clause_id: string | null;
    }>(
      `SELECT step_order, step, pinned_inputs, clause_id
         FROM computation_trace
        WHERE client_id = $1 AND audit_run_id = $2
        ORDER BY step_order`,
      [clientId, chain.finding.auditRunId],
    );

    lines.push({
      disputeLineId: lineRow.id,
      varianceFindingId: lineRow.variance_finding_id,
      amount: lineRow.amount,
      currency: lineRow.currency,
      defensibilityChain: chain,
      computationTrace: traceRows.map((t) => ({
        stepOrder: t.step_order,
        step: t.step,
        pinnedInputs: t.pinned_inputs,
        clauseId: t.clause_id,
      })),
    });
  }

  return { disputeId, lines };
}
