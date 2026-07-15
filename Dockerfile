FROM node:20-bookworm

# ffmpeg for audio extraction, python3+pip for yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY scripts/requirements.txt scripts/requirements.txt
RUN pip3 install --break-system-packages -r scripts/requirements.txt

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
