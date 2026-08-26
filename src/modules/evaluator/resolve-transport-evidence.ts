import type pg from 'pg';

export async function resolveTransportEvidence(
  client: pg.PoolClient, clientId: string, shipmentId: string | null | undefined,
): Promise<string | null> {
  if (!shipmentId) return null;
  const result = await client.query<{ transport_document_id: string | null }>(
    `SELECT transport_document_id FROM shipment WHERE id = $1 AND client_id = $2`, [shipmentId, clientId]);
  const row = result.rows[0];
  if (!row) throw new Error(`shipment not found for tenant: ${shipmentId}`);
  if (!row.transport_document_id) throw new Error(`transport evidence not found for shipment: ${shipmentId}`);
  return row.transport_document_id;
}
