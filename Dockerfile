# Debian-based Node so apt's ffmpeg (built WITH libass) + real fonts are available.
# This is the fix for "captions not burning": the previous renderer's ffmpeg
# lacked libass / fonts, so the ass= filter produced nothing.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      fonts-liberation \
      fontconfig \
      ca-certificates \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
