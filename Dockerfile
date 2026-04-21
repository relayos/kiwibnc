FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 7778

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "kiwibnc.js"]
