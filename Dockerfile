FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg bash git curl ca-certificates python3 python3-pip \
    && pip3 install --break-system-packages openai-whisper \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code 2>/dev/null || true

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /data logs

ENV NODE_ENV=production
ENV DB_DIR=/data

CMD ["node", "bot.mjs"]
