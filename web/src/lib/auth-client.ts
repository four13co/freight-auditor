import { createAuthClient } from 'better-auth/react';
import { passkeyClient } from '@better-auth/passkey/client';

/**
 * better-auth's React client, talking to the handler mounted at
 * /api/auth/* (src/server/auth-routes.ts). No baseURL override -- the app
 * is served same-origin (Fastify serves both the API and the built static
 * frontend), so the client's default (same origin as the page) is correct
 * in every environment without configuration.
 */
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

export const { useSession, signIn, signUp, signOut, requestPasswordReset, resetPassword } = authClient;
