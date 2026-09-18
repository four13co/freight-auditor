import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { makePool } from './helpers.js';
import {
  listContractRates, createContractRate, updateContractRate, deleteContractRate, ContractRateNotFoundError,
} from '../../src/modules/rate-engine/contract-rate-admin.js';
import { listContractVersionsForTenant } from '../../src/modules/rate-engine/list-contract-versions.js';

describe('contract-rate-admin (db)', () => {
  let pool: pg.Pool;
  const tag = `cra-${Date.now()}`;
  let clientId: string;
  let otherClientId: string;
  let contractVersionId: string;
  let otherContractVersionId: string;
  let clauseId: string;

  beforeAll(async () => {
    pool = makePool();
    const owner = await pool.connect();
    try {
      const client = await owner.query(`INSERT INTO account (name, slug) VALUES ('CRA Client', $1) RETURNING id`, [tag]);
      clientId = client.rows[0].id;
      const otherClient = await owner.query(`INSERT INTO account (name, slug) VALUES ('CRA Other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = otherClient.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ('CRA Carrier') RETURNING id`);
      const contract = await owner.query(
        `INSERT INTO contract (account_id, carrier_id, name) VALUES ($1, $2, 'CRA Contract') RETURNING id`,
        [clientId, carrier.rows[0].id],
      );
      const otherContract = await owner.query(
        `INSERT INTO contract (account_id, carrier_id, name) VALUES ($1, $2, 'CRA Other Contract') RETURNING id`,
        [otherClientId, carrier.rows[0].id],
      );
      const version = await owner.query(
        `INSERT INTO contract_version (account_id, contract_id, version_label, valid_from) VALUES ($1, $2, 'v1', CURRENT_DATE) RETURNING id`,
        [clientId, contract.rows[0].id],
      );
      const otherVersion = await owner.query(
        `INSERT INTO contract_version (account_id, contract_id, version_label, valid_from) VALUES ($1, $2, 'v1', CURRENT_DATE) RETURNING id`,
        [otherClientId, otherContract.rows[0].id],
      );
      contractVersionId = version.rows[0].id;
      otherContractVersionId = otherVersion.rows[0].id;

      const clause = await owner.query(
        `INSERT INTO contract_clause (account_id, contract_version_id, clause_ref, text_excerpt) VALUES ($1, $2, '4.2', 'rate clause') RETURNING id`,
        [clientId, contractVersionId],
      );
      clauseId = clause.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM contract_rate WHERE account_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM contract_clause WHERE account_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM contract_version WHERE account_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM contract WHERE account_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM account WHERE id = ANY($1)`, [[clientId, otherClientId]]);
    } finally {
      owner.release();
    }
    await pool.end();
  });

  it('creates a rate, rejecting a contract version that belongs to a different tenant', async () => {
    const client = await pool.connect();
    try {
      await expect(
        createContractRate(client, clientId, { contractVersionId: otherContractVersionId, category: 'LINEHAUL', amount: '100.0000', currency: 'USD' }),
      ).rejects.toThrow(ContractRateNotFoundError);

      const created = await createContractRate(client, clientId, {
        contractVersionId, category: 'LINEHAUL', amount: '900.0000', currency: 'USD', clauseId,
      });
      expect(created.id).toBeTruthy();

      const rates = await listContractRates(client, clientId);
      expect(rates).toHaveLength(1);
      expect(rates[0]).toMatchObject({ category: 'LINEHAUL', amount: '900.0000', currency: 'USD', clauseId, contractVersionId });
    } finally {
      await client.query(`DELETE FROM contract_rate WHERE account_id = $1`, [clientId]);
      client.release();
    }
  });

  it('lists rates scoped to the given tenant only', async () => {
    const client = await pool.connect();
    try {
      await createContractRate(client, clientId, { contractVersionId, category: 'LINEHAUL', amount: '500.0000', currency: 'USD' });
      await createContractRate(client, otherClientId, { contractVersionId: otherContractVersionId, category: 'FUEL', amount: '10.0000', currency: 'USD' });

      const rates = await listContractRates(client, clientId);
      expect(rates.map((r) => r.category)).toEqual(['LINEHAUL']);
    } finally {
      await client.query(`DELETE FROM contract_rate WHERE account_id = ANY($1)`, [[clientId, otherClientId]]);
      client.release();
    }
  });

  it('updates only the provided fields, and clears the clause citation when explicitly set null', async () => {
    const client = await pool.connect();
    try {
      const created = await createContractRate(client, clientId, {
        contractVersionId, category: 'LINEHAUL', amount: '500.0000', currency: 'USD', clauseId,
      });

      const updated = await updateContractRate(client, clientId, created.id, { amount: '525.5000' });
      expect(updated).toBe(true);
      let rates = await listContractRates(client, clientId);
      expect(rates[0]).toMatchObject({ amount: '525.5000', category: 'LINEHAUL', clauseId });

      await updateContractRate(client, clientId, created.id, { clauseId: null });
      rates = await listContractRates(client, clientId);
      expect(rates[0]!.clauseId).toBeNull();

      const wrongTenant = await updateContractRate(client, otherClientId, created.id, { amount: '1.0000' });
      expect(wrongTenant).toBe(false);
    } finally {
      await client.query(`DELETE FROM contract_rate WHERE account_id = $1`, [clientId]);
      client.release();
    }
  });

  it('deletes a rate, scoped to the tenant', async () => {
    const client = await pool.connect();
    try {
      const created = await createContractRate(client, clientId, { contractVersionId, category: 'LINEHAUL', amount: '100.0000', currency: 'USD' });

      const wrongTenantDelete = await deleteContractRate(client, otherClientId, created.id);
      expect(wrongTenantDelete).toBe(false);

      const deleted = await deleteContractRate(client, clientId, created.id);
      expect(deleted).toBe(true);
      const rates = await listContractRates(client, clientId);
      expect(rates).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it('lists contract versions for a tenant, scoped away from another tenant', async () => {
    const client = await pool.connect();
    try {
      const versions = await listContractVersionsForTenant(client, clientId);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ contractVersionId, contractName: 'CRA Contract' });
    } finally {
      client.release();
    }
  });
});
