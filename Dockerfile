FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist ./dist
EXPOSE 80
CMD ["node", "dist/server/index.js"]
