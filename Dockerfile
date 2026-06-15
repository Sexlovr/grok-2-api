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
# DATA_DIR → persistent volume. ADMIN_PASSWORD = admin-panel login.
# REFRESH_TOKEN = shared secret the refresher userscript uses to POST sigs.
# NOTE: public repo → these are world-readable. Move ADMIN_PASSWORD to a Space
# secret to keep it private; unset values are auto-generated + logged at boot.
ENV HOME=/home/node \
    PORT=7860 \
    DATA_DIR=/data \
    ADMIN_PASSWORD=admin \
    REFRESH_TOKEN=d76d38a854fc73623a4c5a681576f6f0

EXPOSE 7860
CMD ["./start.sh"]
