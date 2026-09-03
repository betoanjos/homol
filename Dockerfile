FROM node:20-alpine
# postgresql-client fornece o pg_dump usado pelo backup automático (server/index.js)
RUN apk add --no-cache postgresql-client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "server/index.js"]
