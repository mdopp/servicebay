# Use our pre-built base image with build tools (python3, make, g++)
FROM ghcr.io/mdopp/servicebay/base:dev AS base

# Install dependencies only when needed
FROM base AS deps
# Base image already has libc6-compat python3 make g++
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED 1

RUN npm run build

# Production dependencies stage
# This stage builds native modules (like node-pty) and installs runtime tools
FROM base AS prod-deps
WORKDIR /app
# Base image already has libc6-compat python3 make g++
COPY package.json package-lock.json* ./
# Install prod deps (builds native modules) AND tsx/typescript
RUN npm ci --omit=dev && npm install tsx typescript

# Production image, copy all the files and run next
# Use clean alpine image for runner to keep size down
FROM ghcr.io/mdopp/servicebay/base:prod AS runner
WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1
ENV PATH="/app/node_modules/.bin:$PATH"

# Install ssh-keygen
RUN apk add --no-cache openssh-client

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Runtime dependencies (libstdc++) are already in base:prod

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy templates and stacks
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/stacks ./stacks

# Copy custom server and source code
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

# Copy production node_modules (with built native modules)
COPY --from=prod-deps /app/node_modules ./node_modules

# Ensure permissions for nextjs user
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["tsx", "server.ts"]
