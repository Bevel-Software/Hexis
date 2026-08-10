# Stage 1: Install dependencies and build
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

WORKDIR /app

# Copy workspace config and lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Copy package.json files for all workspace members so pnpm can resolve the
# lockfile before sources are copied.
COPY packages/shared/package.json packages/shared/
COPY packages/core-backend/package.json packages/core-backend/
COPY packages/core-frontend/package.json packages/core-frontend/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Install dependencies (incl. devDependencies — the builder stage needs vite +
# tsc). NODE_ENV is unset at build time, so pnpm installs everything by default.
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/ packages/shared/
COPY packages/core-backend/ packages/core-backend/
COPY packages/core-frontend/ packages/core-frontend/
COPY apps/server/ apps/server/
COPY apps/web/ apps/web/

# NOTE: the branch model is deliberately NOT a build arg any more. It used to
# have to be present during `vite build` because the values were substituted
# into the frontend bundle — which made the image deployment-specific and meant
# renaming a branch required a rebuild. The browser is now served them by
# `GET /api/config` at boot, so this image runs against any deployment and the
# runtime `environment:` block is the only place they are set.

# Build shared + core-backend (tsc → dist), then the SPA (Vite). `pnpm --filter`
# routes through pnpm's workspace binary links.
RUN pnpm --filter @bevel-software/platform-shared run build
RUN pnpm --filter @bevel-software/platform-core-backend run build
RUN pnpm --filter @bevel-software/web run build

# Third-party licence notices for the image. MIT/BSD/Apache all permit
# redistribution only if their copyright notice ships with the distribution,
# and Vite strips comments out of the bundle — so the notices are re-attached
# as a file here. Generated rather than copied in: the file is .gitignore'd
# because its content depends on which platform's optional binaries are
# installed, and this stage is the one that resolved them. Also fails the build
# outright on a denied licence (GPL/AGPL/…), so a bad dependency cannot ship.
COPY scripts/ scripts/
RUN node scripts/generate-license-notices.mjs

# Stage 2: Production image
FROM node:22-slim AS production

RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

# git backs every workspace operation (clone/commit/push of the KB repo).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# tsx runs the TypeScript server shell at runtime. It lives in apps/server's
# devDependencies, so pnpm only links it under apps/server/node_modules/.bin —
# installing it globally puts it on PATH regardless of the working directory.
RUN npm install -g tsx@4.21.0

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/core-backend/package.json packages/core-backend/
COPY packages/core-frontend/package.json packages/core-frontend/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Install production deps only — the runtime needs no devDependencies (tsx is
# installed globally above).
RUN pnpm install --frozen-lockfile --prod

# Compiled packages + their packaged assets. `coreMigrationsDir()` /
# `defaultKbTemplateDir()` resolve these relative to the package root, so the
# layout must mirror the source tree.
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/core-backend/dist packages/core-backend/dist
COPY --from=builder /app/packages/core-backend/migrations packages/core-backend/migrations
COPY --from=builder /app/packages/core-backend/kb-template packages/core-backend/kb-template

# The server shell (tsx runs TypeScript directly) + the built SPA it serves.
COPY --from=builder /app/apps/server/src apps/server/src
COPY --from=builder /app/apps/web/dist apps/web/dist

# Attribution for every third-party package in the production graph, plus our
# own licence. Both must be present in the shipped image, not just the repo.
COPY --from=builder /app/THIRD-PARTY-NOTICES.md ./
COPY LICENSE ./

ENV NODE_ENV=production
ENV PORT=3001

# Bake the deployed commit sha into the image so `GET /api/health` can report
# it. `.git` is in .dockerignore, so the sha can't be read inside the build —
# pass it in explicitly: `--build-arg GIT_SHA=$(git rev-parse HEAD)`, which is
# what CI does. `docker-compose.yml` deliberately does NOT declare it as a build
# arg — naming it there made every deployment UI reading that file ask for a
# value nobody sets by hand. Unset, health reports 'unknown'.
ARG GIT_SHA
ENV GIT_SHA=${GIT_SHA}

EXPOSE 3001

WORKDIR /app/apps/server
CMD ["tsx", "src/main.ts"]
