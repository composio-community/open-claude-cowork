FROM node:20-slim

# Install minimal system dependencies needed by Claude Agent SDK / MCP child processes
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend dependencies first for optimal Docker layer caching
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

# Copy application source (server, web UI renderer, and project Claude skills)
COPY package.json ./
COPY server ./server
COPY renderer ./renderer
COPY .claude ./.claude

# Cloud Run sets PORT=8080 by default; local Docker can override with PORT=3001 or 8080
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/api/health || exit 1

CMD ["node", "server/server.js"]
