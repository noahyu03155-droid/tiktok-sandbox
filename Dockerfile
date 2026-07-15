FROM node:20-bookworm

# ffmpeg for audio extraction, python3+pip for yt-dlp, fonts-noto-cjk so the
# storyboard render's burned-in captions can draw both Latin and Chinese text
# (drawtext needs a real font file on disk — see src/lib/storyboardCaptions.ts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip python3-venv fonts-noto-cjk \
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
