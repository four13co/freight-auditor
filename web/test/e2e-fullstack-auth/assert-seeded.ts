import type { APIRequestContext, APIResponse } from '@playwright/test';

interface SeedCheck {
  check: () => Promise<APIResponse>;
  errorHint: string;
  validate?: (response: APIResponse) => boolean | Promise<boolean>;
}

export async function assertSeeded(_request: APIRequestContext, check: SeedCheck): Promise<void> {
  const response = await check.check();
  const valid = response.ok() && (check.validate ? await check.validate(response) : true);
  if (!valid) {
    throw new Error(`Full-stack e2e setup check failed (HTTP ${response.status()}). ${check.errorHint}`);
  }
}
