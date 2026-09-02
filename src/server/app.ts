import Fastify, { type FastifyInstance } from 'fastify';
import { registerFindingsRoutes } from './findings-routes.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerStaticRoutes } from './static-routes.js';
import { registerMetricsRoutes } from './metrics-routes.js';
import { registerAuditRunsRoutes } from './audit-runs-routes.js';
import { registerInvoiceDraftsRoutes } from './invoice-drafts-routes.js';
import { registerEvidenceRoutes } from './evidence-routes.js';
import { registerRuleGovernanceRoutes } from './rule-governance-routes.js';
import { registerContractsRoutes } from './contracts-routes.js';
import { registerClarificationAnswersRoutes } from './clarification-answers-routes.js';
import { registerClaimRoutes } from './claim-routes.js';
import { registerClaimRecoveryRoutes } from './claim-recovery-routes.js';
import { registerPaymentRoutes } from './payment-routes.js';
import { registerDisputeReviewRoutes } from './dispute-review-routes.js';
import { registerPortfolioRoutes } from './portfolio-routes.js';
import { registerPortalAdminRoutes } from './portal-admin-routes.js';
import { registerRecoveryReportRoutes } from './recovery-report-routes.js';

/**
 * Build the Fastify application instance.
 *
 * Kept separate from the server bootstrap (`index.ts`) so tests can build the
 * app and call `.inject()` without binding a TCP port.
 *
 * 86e2wb4zg: composes domain route modules rather than registering routes
 * inline -- app.ts previously carried every route plus their shared
 * imports/consts at its top level, which was the repo's one recurring
 * merge-collision point (86e2wwaeq's architecture review: PR #93 vs #91/#92,
 * PR #94 vs #91/#92, PR #103 vs #101/#102, all colliding on this same
 * top-of-file seam). Each domain module now owns its own imports/consts
 * alongside its routes; app.ts only imports and registers them.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  // Static/health routes registered at top level -- must NOT opt into the
  // shared registerTenantAuthPreHandler used by tenant-scoped route modules.
  void app.register(registerStaticRoutes);

  // Worker-throughput/queue-backlog + discovery metrics (P6.C.4): also
  // top-level and unauthenticated, same posture as /health -- a Prometheus
  // scraper carries no session.
  void app.register(registerMetricsRoutes);

  // Auth routes registered at top level -- must be reachable with only a
  // session cookie (or no session at all), before any tenant scope exists
  // (see auth-routes.ts's header comment for why this can't be gated).
  void app.register(registerAuthRoutes);

  // Findings routes registered via their own encapsulation so the
  // tenant-auth preHandler binds ONLY to these routes (see
  // findings-routes.ts's header comment).
  void app.register(registerFindingsRoutes);

  // Audit-runs routes registered via their own encapsulation (86e2v17u9),
  // same tenant-auth preHandler pattern as findings-routes.ts but a distinct
  // resource with its own raw-body content-type parser scoped to this
  // plugin only.
  void app.register(registerAuditRunsRoutes);

  // Invoice-drafts routes (86e2xb911): the PDF-upload draft/confirm flow,
  // additive alongside audit-runs-routes.ts's raw-EDI path -- same
  // tenant-auth preHandler pattern, its own raw-body (application/pdf)
  // content-type parser scoped to this plugin only.
  void app.register(registerInvoiceDraftsRoutes);
  void app.register(registerEvidenceRoutes);
  void app.register(registerRuleGovernanceRoutes);
  void app.register(registerContractsRoutes);
  void app.register(registerClarificationAnswersRoutes);
  void app.register(registerClaimRoutes);

  // Claim + recovery read APIs (P5.B.4): list + detail, same tenant-auth
  // preHandler pattern as the modules above, its own encapsulated plugin
  // instance.
  void app.register(registerClaimRecoveryRoutes);

  // Payment authorization routes (P4.B.5): same tenant-auth preHandler
  // pattern as the modules above, its own encapsulated plugin instance.
  void app.register(registerPaymentRoutes);

  // Dispute review + approval routes (P4.C.6): same tenant-auth preHandler
  // pattern, its own encapsulated plugin instance.
  void app.register(registerDisputeReviewRoutes);

  // Cross-client portfolio reporting for internal analysts (P5.C.3): its
  // OWN preHandler (registerInternalAnalystAuthPreHandler), deliberately
  // NOT the shared registerTenantAuthPreHandler every module above uses --
  // see portfolio-routes.ts's header comment for why.
  void app.register(registerPortfolioRoutes);

  // Portal-specific tenant-scoped APIs (P6.A.4): client_admin/client_viewer
  // membership roster + role management, the first consumers of
  // client-admin-auth.ts's/client-viewer-auth.ts's preHandlers.
  void app.register(registerPortalAdminRoutes);

  // Client-level recovery reporting (P5.C.2): the single-tenant analog of
  // registerPortfolioRoutes above, gated by the shared registerTenantAuthPreHandler
  // (unlike portfolio-routes.ts's internal-analyst-only gate) and reusing
  // getPortfolioReconciliation (P5.C.4) as-is.
  void app.register(registerRecoveryReportRoutes);

  return app;
}
