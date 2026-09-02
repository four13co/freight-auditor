import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../../src');

/**
 * 86e2zfjym AC4: "a write operation always goes through the primary pool --
 * withTenantReadTx is never imported by a mutating module (code-level
 * check)."
 *
 * DIVERGENCE from AC4's literal "module" wording, named explicitly (see the
 * PR body): findings-routes.ts is a mutating module by the item's own
 * Solution text (it names `GET /api/findings` -- in that same file -- as one
 * of the "1-2 concrete high-volume read-only endpoints" to route through the
 * seam), so a strict file-level reading of AC4 is unsatisfiable together with
 * that example. This test instead enforces the invariant AC4 actually cares
 * about at call-site granularity: walks every .ts file under src/, and for
 * each call to `withTenantReadTx(`, finds the nearest Fastify
 * route-registration call above it in the same file and asserts it's a
 * `.get(` -- never `.post(`/`.patch(`/`.put(`/`.delete(`. That is a strictly
 * *stronger* guarantee for the property AC4 is protecting (no write ever
 * reads its data from a lagging replica) than a module-level import check
 * would be, since it also catches a future GET-only file that later grows a
 * mutating route reusing the same variable. tenant-context.ts's own `export
 * async function withTenantReadTx(` definition line is excluded (it's the
 * declaration, not a call site).
 */
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ROUTE_METHOD_RE = /\.\s*(get|post|patch|put|delete)\s*\(/;

function nearestRouteMethodAbove(lines: string[], usageLineIdx: number): string | undefined {
  for (let i = usageLineIdx; i >= 0; i--) {
    const m = (lines[i] ?? '').match(ROUTE_METHOD_RE);
    if (m) return m[1];
  }
  return undefined;
}

describe('withTenantReadTx write-safety (86e2zfjym AC4)', () => {
  it('is only ever called from within a GET route handler, never a mutating one', () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(SRC_DIR)) {
      const content = readFileSync(file, 'utf8');
      if (!content.includes('withTenantReadTx')) continue;
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (!line.includes('withTenantReadTx(')) return;
        if (/export\s+async\s+function\s+withTenantReadTx\s*\(/.test(line)) return; // the definition itself
        const method = nearestRouteMethodAbove(lines, idx);
        if (method !== 'get') {
          violations.push(`${file}:${idx + 1} calls withTenantReadTx under a .${method ?? 'unknown'}( route`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('is actually reachable from at least one real route today, so the check above is not vacuous', () => {
    let callSites = 0;
    for (const file of walkTsFiles(SRC_DIR)) {
      const content = readFileSync(file, 'utf8');
      const matches = content.match(/withTenantReadTx\(/g) ?? [];
      const isDefinitionFile = /export\s+async\s+function\s+withTenantReadTx\s*\(/.test(content);
      callSites += isDefinitionFile ? Math.max(0, matches.length - 1) : matches.length;
    }
    expect(callSites).toBeGreaterThan(0);
  });
});
