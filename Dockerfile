FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip make g++ ffmpeg bash git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data logs

ENV NODE_ENV=production
ENV DB_DIR=/data

CMD ["node", "bot.mjs"]
