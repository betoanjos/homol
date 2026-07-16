FROM node:20-alpine
RUN apk add --no-cache yarn
WORKDIR /app
COPY package.json ./
RUN yarn install --frozen-lockfile --network-timeout 300000
COPY . .
EXPOSE 3001
CMD ["node", "server/index.js"]
