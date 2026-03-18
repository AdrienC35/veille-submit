FROM node:20-alpine

# yt-dlp for YouTube title/transcript extraction (optional but recommended)
RUN apk add --no-cache python3 py3-pip ffmpeg \
    && pip3 install --break-system-packages yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

EXPOSE 7890
CMD ["node", "server.js"]
