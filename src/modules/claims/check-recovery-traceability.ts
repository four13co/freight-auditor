/**
 * Read-side traceability check for one recovery_event (P5.A.7): every
 * recovered dollar should trace back to at least one contract clause or
 * rate-cell citation, via one of two paths:
 *
 * - DIRECT: recovery_event.variance_finding_id is populated (both writers
 *   built this session accept it as an optional parameter -- P5.A.3/#171,
 *   P5.A.4/#174 -- so it is not guaranteed to be set).
 * - INDIRECT: the event's claim has a dispute_id, and at least one of that
 *   dispute's dispute_line rows resolves to a variance_finding with a
 *   citation (clause or rate cell).
 *
 * A recovery_event with neither a direct variance_finding_id nor a
 * traceable dispute is UNTRACEABLE -- this is a genuine, reportable finding
 * (a claim created without a dispute, per P5.A.1/#165's own design, has no
 * indirect path available), not an error this function raises.
 */
export interface CitedFindingRow {
  varianceFindingId: string;
  hasCitation: boolean;
}

export interface RecoveryTraceabilityResult {
  recoveryEventId: string;
  traceable: boolean;
  path: 'DIRECT' | 'INDIRECT' | 'UNTRACEABLE';
  citedVarianceFindingIds: string[];
}

export function checkRecoveryTraceability(
  recoveryEventId: string,
  directVarianceFindingId: string | null,
  directFindingHasCitation: boolean | null,
  disputeLineFindings: readonly CitedFindingRow[],
): RecoveryTraceabilityResult {
  if (directVarianceFindingId !== null) {
    const traceable = directFindingHasCitation === true;
    return {
      recoveryEventId,
      traceable,
      path: 'DIRECT',
      citedVarianceFindingIds: traceable ? [directVarianceFindingId] : [],
    };
  }

  const cited = disputeLineFindings.filter((f) => f.hasCitation);
  if (cited.length > 0) {
    return {
      recoveryEventId,
      traceable: true,
      path: 'INDIRECT',
      citedVarianceFindingIds: cited.map((f) => f.varianceFindingId),
    };
  }

  return { recoveryEventId, traceable: false, path: 'UNTRACEABLE', citedVarianceFindingIds: [] };
}
