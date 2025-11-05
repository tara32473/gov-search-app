# Government Watchdog App - Production Docker Image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S govwatchdog -u 1001

# Copy package files
COPY backend/package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY backend/ .
COPY frontend/dist/ ./public/

# Set proper ownership
RUN chown -R govwatchdog:nodejs /app

# Switch to non-root user
USER govwatchdog

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# Start application
CMD ["node", "server.js"]