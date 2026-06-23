# Stage 1: Build dependencies
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Stage 2: Runner image
FROM node:20-alpine

WORKDIR /app

# Copy node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy package files
COPY package.json ./

# Copy backend files
COPY server.js db.js insights.js bedrock.js langsmith.js secrets.js cost-config.json ./

# Copy frontend static public files
COPY public ./public

# Create a directory for persistent SQLite data and make it writable by node user
RUN mkdir -p /app/data && chown -R node:node /app

# Switch to the non-root node user
USER node

# Default Environment Variables
ENV PORT=3090
ENV CT_DB_PATH=/app/control-tower.db
ENV NODE_ENV=production

# Expose the API port
EXPOSE 3090

# Start the application
CMD ["node", "server.js"]
