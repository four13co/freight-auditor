import type pg from 'pg';
import type { ObjectStore } from '../reference-data/object-store.js';
import { storeSourceDocument, type SourceDocumentRef } from '../reference-data/source-document.js';

/**
 * Client + carrier onboarding (Master Spec §12 — the Phase 0 exit criterion):
 * create a client and a carrier, then store a raw EDI file and a contract PDF
 * immutably. This is the internal-analyst provisioning path; client
 * self-service is Phase 6.
 *
 * All DB work runs inside the caller's tenant transaction (withTenantTx). Since
 * onboarding a *new* client is an internal-analyst act (the client doesn't exist
 * to be scoped to yet), the caller opens the transaction with `internal: true`.
 */

export interface OnboardClientInput {
  name: string;
  slug: string;
}

export interface OnboardCarrierInput {
  name: string;
  scacCode?: string;
}

export interface OnboardDocumentsInput {
  clientId: string;
  rawEdi: Buffer;
  contractPdf: Buffer;
}

export async function createClient(
  client: pg.PoolClient,
  input: OnboardClientInput,
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ($1, $2) RETURNING id`,
    [input.name, input.slug],
  );
  return { id: rows[0]!.id };
}

export async function createCarrier(
  client: pg.PoolClient,
  input: OnboardCarrierInput,
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO carrier (name, scac_code) VALUES ($1, $2) RETURNING id`,
    [input.name, input.scacCode ?? null],
  );
  return { id: rows[0]!.id };
}

/**
 * Store the onboarding documents immutably. Returns both refs; re-running with
 * identical bytes is idempotent (same document ids) via source_document.sha256.
 */
export async function storeOnboardingDocuments(
  client: pg.PoolClient,
  store: ObjectStore,
  input: OnboardDocumentsInput,
): Promise<{ rawEdi: SourceDocumentRef; contractPdf: SourceDocumentRef }> {
  const rawEdi = await storeSourceDocument(client, store, {
    clientId: input.clientId,
    bytes: input.rawEdi,
    contentType: 'application/edi-x12',
  });
  const contractPdf = await storeSourceDocument(client, store, {
    clientId: input.clientId,
    bytes: input.contractPdf,
    contentType: 'application/pdf',
  });
  return { rawEdi, contractPdf };
}
