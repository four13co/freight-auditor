import { createAuthClient } from 'better-auth/react';

/**
 * 86e2v1bdj: better-auth's React client, talking to the handler 86e2v1bdj
 * mounted at /api/auth/* (src/server/app.ts). No baseURL override -- the
 * app is served same-origin (Fastify serves both the API and the built
 * static frontend), so the client's default (same origin as the page) is
 * correct in every environment without configuration.
 */
export const authClient = createAuthClient();

export const { useSession, signIn, signUp, signOut } = authClient;
