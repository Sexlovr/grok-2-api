FROM node:20-bullseye-slim

# Pure-Node now — no browser, no Xvfb. Just git/TLS/CRLF-guard.
RUN apt-get update && apt-get install -y --no-install-recommends \
    dos2unix ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/node/app

# Install node deps first (layer cache).
COPY package.json ./
RUN npm install --omit=dev

# App source
COPY . .
RUN dos2unix start.sh && chmod +x start.sh \
    && mkdir -p /data && chown -R node:node /home/node/app /data

USER node
# DATA_DIR → persistent volume; ADMIN_PASSWORD / REFRESH_TOKEN via secrets
# (auto-generated + logged if unset).
ENV HOME=/home/node \
    PORT=7860 \
    DATA_DIR=/data

EXPOSE 7860
CMD ["./start.sh"]
