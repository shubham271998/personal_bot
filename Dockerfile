FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg bash git curl ca-certificates python3 python3-pip \
    && pip3 install --break-system-packages openai-whisper \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code || true

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data logs models/insightface

VOLUME ["/app/data", "/app/logs", "/app/models"]

ENV NODE_ENV=production

CMD ["node", "bot.mjs"]
