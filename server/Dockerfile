# Self-host image. Build context = server/. Config comes from env only (see ../.env.example).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 VAULT_DIR=/vault
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /vault && chown node:node /vault
USER node
EXPOSE 3000
CMD ["node", "dist/node.js"]
