import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 80);
const HOST = process.env.BIND_HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const app = buildApp();
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
