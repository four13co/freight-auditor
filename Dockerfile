FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist ./dist
# 86e2v07n3: the frontend arrives pre-built (deploy.yml builds it, never this
# image) -- src/server/app.ts's resolveWebDist() is import.meta.url-relative
# to the RUNNING compiled file (dist/server/app.js at /app/dist/server/app.js
# in this image), so ../../web/dist from there resolves to /app/web/dist.
# This COPY destination must match that exactly, or the server silently
# serves no frontend (resolveWebDist() tolerates a missing dir by design) --
# verified empirically by running the compiled server against this exact
# /app/dist + /app/web/dist layout before landing this path.
COPY web/dist ./web/dist

# 86e2v0acm: runtime config (DATABASE_URL, SESSION_SECRET, HOST) was never wired
# into this container -- CapRover's app-level env config is NOT the source here.
# deploy.yml resolves .env.template via 1Password and ships the RESOLVED .env in
# the tarball; own layer so it doesn't bust the dependency-install cache above.
# An image built without a .env (e.g. local `docker build` with no deploy.yml
# pipeline) still boots -- --env-file-if-exists, not --env-file.
COPY .env ./.env
EXPOSE 80
CMD ["node", "--env-file-if-exists=.env", "dist/server/index.js"]
