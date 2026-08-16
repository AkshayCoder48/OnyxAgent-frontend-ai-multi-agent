FROM oven/bun:1 AS base

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./
COPY cli/package.json cli/bun.lock* ./cli/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build the Next.js app
RUN bun run build

# Expose port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Start the app
CMD ["bun", "run", "start"]
