# Locally-built Penpot MCP server image carrying the develop-branch AI-iteration
# upgrades (configurable/per-call task timeout, error de-wrapping, resilient traversal,
# stable exports). Runtime deps are installed fresh; the server bundle (index.js) and
# its data/static resources are copied from the esbuild output.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/penpot/mcp

# install only the externalized runtime dependencies
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# the built server bundle + its resources (cwd must be this dir: ApiDocs/ConfigurationLoader
# read ./data from process.cwd())
COPY dist/ ./

ENV PENPOT_MCP_SERVER_HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 4401 4402 4403

# single-user mode: one local browser plugin connection, tokenless MCP client access
CMD ["node", "index.js"]
