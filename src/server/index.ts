import { buildApp } from './app.js';
import { fakeExtractInvoiceFromText } from './e2e-fake-extraction.js';

const PORT = Number(process.env.PORT ?? 80);
const HOST = process.env.BIND_HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  // 86e36yj9d: E2E_FAKE_INVOICE_EXTRACTION swaps the client-portal Uploads
  // section's invoice-extraction call for a deterministic double -- same
  // shape as DEV_AUTH_HEADERS (a boot-time env flag read only here, never in
  // route/module code) -- so the real-session fullstack-auth e2e suite can
  // drive a real browser upload without ever reaching the live Anthropic API.
  // See e2e-fake-extraction.ts's header comment.
  const app = buildApp(
    process.env.E2E_FAKE_INVOICE_EXTRACTION === '1'
      ? { invoiceExtractImpl: fakeExtractInvoiceFromText }
      : undefined,
  );
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
