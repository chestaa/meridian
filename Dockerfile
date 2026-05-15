FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts

RUN npm install

COPY . .

CMD ["npm", "start"]
