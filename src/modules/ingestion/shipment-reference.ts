import type pg from 'pg';

/** Match source-document references against tenant-owned shipments before pure evaluation. */
export async function resolveShipmentReferenceMatch(
  client: pg.PoolClient,
  clientId: string,
  references: string[] | undefined,
): Promise<boolean | undefined> {
  const normalized = [...new Set((references ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return undefined;

  const result = await client.query(
    `SELECT 1 FROM shipment
     WHERE client_id = $1 AND lower(btrim(reference)) = ANY($2::text[])
     LIMIT 1`,
    [clientId, normalized],
  );
  return (result.rowCount ?? 0) > 0;
}
