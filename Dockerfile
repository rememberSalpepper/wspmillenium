FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "start"]
