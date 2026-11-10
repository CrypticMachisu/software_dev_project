# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY neon.ts ./
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The server reads these from src/ at runtime, so they are copied, not compiled.
COPY src/admin/views ./src/admin/views
COPY src/admin/public ./src/admin/public
COPY src/public ./src/public
COPY SQL ./SQL
USER node
EXPOSE 3000
# DATABASE_URL (and any payment settings) come from the environment, not a baked .env.
CMD ["node", "dist/src/server.js"]
