FROM node:24-bookworm-slim

ARG BOT_REVISION=development
LABEL org.opencontainers.image.title="WhatsApp Summary Bot"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    CHATGPT_LOGIN_PORT=17778 \
    USER=container \
    HOME=/home/container

# Baileys connects directly to WhatsApp; no browser runtime is required.
# Wings controls the runtime UID/GID; /opt/bot remains readable by that user.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupmod --new-name container node \
    && usermod --login container --home /home/container node \
    && mkdir -p /home/container /opt/bot \
    && chown container:container /home/container

WORKDIR /opt/bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY src/ ./src/
COPY scripts/check-runtime.mjs ./scripts/check-runtime.mjs
RUN printf '%s\n' "$BOT_REVISION" > /opt/bot/REVISION \
    && chmod -R a+rX /opt/bot \
    && node scripts/check-runtime.mjs

COPY --chmod=755 deploy/pterodactyl/entrypoint.sh /entrypoint.sh

USER container
WORKDIR /home/container
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
