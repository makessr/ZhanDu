FROM node:26-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs onboarding.mjs auth-v2.mjs ./
COPY deploy/backup-snapshot.mjs deploy/portable-backup.mjs ./
RUN mkdir /data && chown node:node /data
USER node
ENV FINESHELL_SYNC_DATABASE=/data/vault.sqlite
ENV FINESHELL_SYNC_HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "server.mjs"]
