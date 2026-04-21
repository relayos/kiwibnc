FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data

ENV KIWIBNC_CONFIG=/data/config.ini

EXPOSE 7778

CMD ["node", "kiwibnc.js", "--config", "/data/config.ini"]
