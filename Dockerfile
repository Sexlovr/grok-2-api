FROM node:20-bullseye

# OS deps: Xvfb + xauth (virtual display for headful Chromium → better anti-bot
# posture; xvfb-run needs xauth for the X authority cookie),
# plus the libs Chromium needs. dos2unix guards against CRLF in start.sh.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth dos2unix ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/node/app

# Install node deps first (layer cache), then Playwright's Chromium + its OS deps.
COPY package.json ./
RUN npm install
RUN npx playwright install --with-deps chromium

# App source
COPY . .
RUN dos2unix start.sh && chmod +x start.sh && chown -R node:node /home/node/app

USER node
ENV HOME=/home/node \
    PORT=7860 \
    DATA_DIR=/home/node/app/data \
    ADMIN_PASSWORD=admin \
    HEADLESS=0

EXPOSE 7860
CMD ["./start.sh"]
