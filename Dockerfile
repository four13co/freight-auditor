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
EXPOSE 80
CMD ["node", "dist/server/index.js"]
