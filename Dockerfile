FROM node:20-bullseye-slim

# In-Space signer browser stack:
#  - chromium      → the plain HEADED browser that mints valid sigs (no CDP).
#  - xvfb          → lightweight virtual display (NOT a VNC desktop).
#  - scrot/ffmpeg  → single-frame screenshots for the recovery console.
#  - xdotool       → relay clicks/keys into the browser for the recovery console.
#  - fonts/libs    → so chromium renders pages (and the SVG canary) correctly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    dos2unix ca-certificates \
    chromium xvfb scrot ffmpeg xdotool \
    fonts-liberation fonts-noto-color-emoji \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpangocairo-1.0-0 libgtk-3-0 \
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
# REFRESH_TOKEN = shared secret the signer (extension/userscript) uses to POST sigs.
# CHROMIUM_BIN → where the headed browser lives. ENABLE_BROWSER=0 disables the
# in-Space browser and reverts to pure-Node + userscript relay.
# NOTE: public repo → these are world-readable. Move ADMIN_PASSWORD to a Space
# secret to keep it private; unset values are auto-generated + logged at boot.
ENV HOME=/home/node \
    PORT=7860 \
    DATA_DIR=/data \
    CHROMIUM_BIN=/usr/bin/chromium \
    ENABLE_BROWSER=1 \
    ADMIN_PASSWORD=admin \
    REFRESH_TOKEN=d76d38a854fc73623a4c5a681576f6f0

EXPOSE 7860
CMD ["./start.sh"]
