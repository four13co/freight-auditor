import type { Page } from '@playwright/test';

/**
 * 86e2xcnzy: the "fill email -> fill password -> click Sign in" sequence was
 * copy-pasted 4 times across this suite's two spec files
 * (real-session.fullstack.spec.ts's AC1/AC2, passkey.fullstack.spec.ts's
 * registration test and AC3). One shared helper so the login form's field
 * labels/button text only need updating in one place.
 */
export async function loginViaForm(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
