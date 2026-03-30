# Stage 1: Build Svelte web UI
FROM node:22-slim AS web-builder
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --ignore-scripts 2>/dev/null || npm install
COPY web/ ./
RUN npm run build

# Stage 2: Python runtime
FROM python:3.12-slim AS runtime
LABEL maintainer="Phil Lafayette"
LABEL description="Claude Comms - Distributed inter-Claude messaging platform"

# Avoid Python buffering (important for container logs)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install only the Python package and dependencies
COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --no-cache-dir ".[all]"

# Copy pre-built web assets into the package data directory
COPY --from=web-builder /build/web/dist /app/web-dist

# Create data directory for config and logs
RUN mkdir -p /root/.claude-comms

# Expose ports:
#   1883 - MQTT TCP
#   9001 - MQTT WebSocket
#   9920 - MCP HTTP server
#   9921 - Web UI
EXPOSE 1883 9001 9920 9921

# Health check: verify MQTT broker port is accepting connections
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import socket; s=socket.create_connection(('127.0.0.1', 1883), timeout=3); s.close()" || exit 1

ENTRYPOINT ["claude-comms"]
CMD ["start", "--web"]
