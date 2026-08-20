import { createAuthClient } from 'better-auth/react';
import { passkeyClient } from '@better-auth/passkey/client';

/**
 * 86e2v1bdj: better-auth's React client, talking to the handler 86e2v1bdj
 * mounted at /api/auth/* (src/server/app.ts). No baseURL override -- the
 * app is served same-origin (Fastify serves both the API and the built
 * static frontend), so the client's default (same origin as the page) is
 * correct in every environment without configuration.
 *
 * 86e2v1bf1: passkeyClient() adds signIn.passkey(...) and
 * authClient.passkey.addPasskey(...) -- no server-side field remap needed
 * on this side (that only applies to src/auth/better-auth.ts's own DB
 * column mapping); the client just talks to /api/auth/passkey/* the same
 * way it already talks to /api/auth/sign-in/email.
 */
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
