# Container image for the API, the candidate app and the admin panel.
# No npm install step: the server uses Node's own modules only.
#
#   docker build -t exam-simulator .
#
# Pin the base image by digest for releases (docker buildx imagetools inspect node:22-alpine).
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /srv/app
# Only what runs in production: no tests, no seed data, no prototype.
COPY --chown=root:root packages/exam-engine/src packages/exam-engine/src
COPY --chown=root:root packages/exam-engine/data packages/exam-engine/data
COPY --chown=root:root packages/exam-store/src packages/exam-store/src
COPY --chown=root:root packages/api/src packages/api/src
COPY --chown=root:root packages/admin-web/index.html packages/admin-web/index.html
COPY --chown=root:root packages/candidate-web/index.html packages/candidate-web/landing.html packages/candidate-web/sw.js packages/candidate-web/
COPY --chown=root:root packages/candidate-web/assets packages/candidate-web/assets
COPY --chown=root:root db/migrations db/migrations
COPY --chown=root:root scripts/migrate.ts scripts/create-admin.ts scripts/start.ts scripts/
# Synthetic demo bank: loaded only when DEMO_CONTENT=1 and never in production mode.
COPY --chown=root:root db/seed db/seed
COPY --chown=root:root package.json ./

# The application files are read-only to the user that runs them.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migrates, then starts the server (see scripts/start.ts).
CMD ["node", "scripts/start.ts"]
