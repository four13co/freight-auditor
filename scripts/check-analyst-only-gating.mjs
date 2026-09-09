#!/usr/bin/env node
// 86e36bf83: static check for the recurring review finding (role-blind-preauth-
// gate, seen 5x across 3 review cycles) -- a mutating route registered behind
// registerTenantAuthPreHandler (grants a full read+write TenantContext to ANY
// membership role) instead of also requiring an explicit role-scoped preHandler
// for an internal-analyst-only (or other role-restricted) action. All 5 known
// sites are fixed (bf3a3d5; PR #336; PR #339); nothing previously caught a NEW
// route being added without the gate, and this bug class had already recurred
// twice. This closes that gap at write-time instead of a later security audit.
//
// Deliberately narrow (Rabbit holes): scans only the one shape every route
// file in this repo actually uses -- a `<scope>.<method>(<path>, ...)` mutating
// call, and a `<outer>.register(async (<scope>) => { ... })` nested sub-scope
// -- via brace-matched text scanning, not a full AST/ESLint rule. A route is
// gated only if its enclosing register() block calls one of the KNOWN
// role-scoped preHandlers (never the generic registerTenantAuthPreHandler,
// which grants access to any membership role) on that exact scope variable.
// Anything else must be in the explicit ALLOW_LISTED_ROUTES below -- a new
// allow-list entry is itself a visible, reviewable diff line, so the check
// never needs to guess intent, only require an explicit statement of it.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SRC_SERVER_DIR = join(new URL('../src/server', import.meta.url).pathname);

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);

/**
 * PreHandlers that restrict access to a SPECIFIC role -- never the generic
 * any-membership-role registerTenantAuthPreHandler, which is deliberately
 * excluded here.
 */
export const ROLE_SCOPED_PREHANDLERS = [
  'registerAnalystOnlyPreHandler',
  'registerInternalAnalystAuthPreHandler',
  'registerClientAdminAuthPreHandler',
  'registerClientViewerAuthPreHandler',
];

/**
 * Routes explicitly accepted as intentionally portal-writable (any
 * authenticated tenant member, not just an internal analyst) -- reviewed
 * against the actual business action each performs, not inferred. Adding a
 * new entry here is itself a visible diff line a PR reviewer sees.
 * @type {{file: string, method: string, path: string, reason: string}[]}
 */
export const ALLOW_LISTED_ROUTES = [
  { file: 'dispute-review-routes.ts', method: 'post', path: '/api/disputes/:id/communications', reason: 'append-only communications log entry, not a dispute-state mutation' },
  { file: 'rule-governance-routes.ts', method: 'post', path: '/api/contracts/rule-proposals/:id/accept', reason: "a tenant accepting a rule change proposed for their OWN contract" },
  { file: 'rule-governance-routes.ts', method: 'post', path: '/api/contracts/rule-proposal-acceptances/:id/ratify', reason: "a tenant ratifying their own prior acceptance -- distinct from the GLOBAL rule ratify/activate below, which IS internal-analyst-gated" },
  { file: 'findings-routes.ts', method: 'patch', path: '/api/findings/:id/status', reason: 'the findings-detail-drawer status transition, a normal tenant action; only reversing a FIRM_RULE verdict is analyst-only' },
  { file: 'findings-routes.ts', method: 'post', path: '/api/findings/:id/action', reason: 'accept/waive/escalate a finding -- a normal tenant action, not an analyst override' },
  { file: 'audit-runs-routes.ts', method: 'post', path: '/api/audit-runs', reason: "a tenant submitting their own invoice/EDI upload for audit" },
  { file: 'audit-runs-routes.ts', method: 'post', path: '/api/audit-runs/:id/replay', reason: "a tenant re-running their own audit run" },
  { file: 'claim-routes.ts', method: 'post', path: '/api/disputes/:id/claim', reason: "a tenant claiming their own dispute for recovery tracking" },
  { file: 'clarification-answers-routes.ts', method: 'put', path: '/api/clarifying-questions/:id/answer', reason: "a tenant answering a clarifying question about their own audit run" },
  { file: 'clarification-answers-routes.ts', method: 'post', path: '/api/extraction-fields/:id/corrections', reason: "a tenant correcting an extracted field on their own document" },
  { file: 'contracts-routes.ts', method: 'post', path: '/api/contracts', reason: "a tenant uploading their own contract" },
  { file: 'contracts-routes.ts', method: 'post', path: '/api/contracts/:id/versions', reason: "a tenant uploading a new version of their own contract" },
  { file: 'contracts-routes.ts', method: 'post', path: '/api/contract-versions/:id/finalize', reason: "a tenant finalizing their own contract version" },
  { file: 'invoice-drafts-routes.ts', method: 'post', path: '/api/invoice-drafts', reason: "a tenant submitting their own invoice draft" },
  { file: 'invoice-drafts-routes.ts', method: 'post', path: '/api/invoice-drafts/:id/confirm', reason: "a tenant confirming their own invoice draft" },
  { file: 'invoice-drafts-routes.ts', method: 'post', path: '/api/invoice-drafts/:id/reject', reason: "a tenant rejecting their own invoice draft" },
];

/** @param {string} file @param {string} method @param {string} path */
function isAllowListed(file, method, path) {
  return ALLOW_LISTED_ROUTES.some((r) => r.file === file && r.method === method.toLowerCase() && r.path === path);
}

/**
 * Finds the index of the `}` matching the `{` at openIndex, skipping over
 * string/template literals and comments so an unrelated brace inside one of
 * those can't desync the count.
 * @param {string} content
 * @param {number} openIndex - index of the opening `{`
 * @returns {number} index of the matching `}`, or -1 if unbalanced
 */
export function findMatchingBrace(content, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const REGISTER_BLOCK = /\.register\(\s*async\s*\(\s*(\w+)\s*\)\s*=>\s*\{/g;

/**
 * @param {string} content
 * @returns {{ varName: string, start: number, end: number, hasRoleGate: boolean }[]}
 */
export function findRegisterBlocks(content) {
  const blocks = [];
  REGISTER_BLOCK.lastIndex = 0;
  let m;
  while ((m = REGISTER_BLOCK.exec(content))) {
    const varName = m[1];
    const openIndex = m.index + m[0].length - 1;
    const end = findMatchingBrace(content, openIndex);
    if (end === -1) continue;
    const body = content.slice(openIndex, end);
    const hasRoleGate = ROLE_SCOPED_PREHANDLERS.some((name) =>
      new RegExp(`\\b${name}\\s*\\(\\s*${varName}\\s*\\)`).test(body),
    );
    blocks.push({ varName, start: openIndex, end, hasRoleGate });
  }
  return blocks;
}

const MUTATING_CALL = /(\w+)\.(post|put|patch|delete)\(\s*(['"`])((?:(?!\3)[^\\]|\\.)*)\3/g;

/**
 * @param {string} content
 * @returns {{ scopeVar: string, method: string, path: string, index: number }[]}
 */
export function findMutatingRouteCalls(content) {
  const calls = [];
  MUTATING_CALL.lastIndex = 0;
  let m;
  while ((m = MUTATING_CALL.exec(content))) {
    const [, scopeVar, method, , path] = m;
    if (!MUTATING_METHODS.has(method)) continue;
    calls.push({ scopeVar, method, path, index: m.index });
  }
  return calls;
}

/**
 * @param {string} fileName - basename, e.g. "dispute-review-routes.ts"
 * @param {string} content
 * @returns {{ file: string, method: string, path: string }[]} ungated, non-allow-listed violations
 */
export function checkFileGating(fileName, content) {
  const blocks = findRegisterBlocks(content);
  const calls = findMutatingRouteCalls(content);
  const violations = [];
  for (const call of calls) {
    const enclosing = blocks.find(
      (b) => b.varName === call.scopeVar && call.index > b.start && call.index < b.end,
    );
    const gated = enclosing ? enclosing.hasRoleGate : false;
    if (gated) continue;
    if (isAllowListed(fileName, call.method, call.path)) continue;
    violations.push({ file: fileName, method: call.method.toUpperCase(), path: call.path });
  }
  return violations;
}

/**
 * @param {{ srcServerDir?: string, readdirImpl?: typeof readdirSync, readFileImpl?: (p: string) => string }} [opts]
 * @returns {{ file: string, method: string, path: string }[]}
 */
export function checkAllRoutes({
  srcServerDir = SRC_SERVER_DIR,
  readdirImpl = readdirSync,
  readFileImpl = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const files = readdirImpl(srcServerDir).filter((f) => f.endsWith('-routes.ts'));
  const violations = [];
  for (const file of files) {
    const content = readFileImpl(join(srcServerDir, file));
    violations.push(...checkFileGating(file, content));
  }
  return violations;
}

export async function main({
  srcServerDir = SRC_SERVER_DIR,
  exit = process.exit,
  log = (msg) => process.stdout.write(`${msg}\n`),
  runImpl = checkAllRoutes,
} = {}) {
  const violations = runImpl({ srcServerDir });
  if (violations.length === 0) {
    log('check-analyst-only-gating: every mutating route in src/server/*-routes.ts is either role-scoped-gated or explicitly allow-listed');
    return;
  }
  log(`check-analyst-only-gating: found ${violations.length} ungated mutating route(s):\n`);
  for (const v of violations) {
    log(`  ${v.file}: ${v.method} ${v.path}`);
  }
  log('\nFix: nest the route in a register() sub-scope that calls a role-scoped preHandler (e.g. registerAnalystOnlyPreHandler), or add an explicit ALLOW_LISTED_ROUTES entry in scripts/check-analyst-only-gating.mjs naming why it is intentionally portal-writable.');
  exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
