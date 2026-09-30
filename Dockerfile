FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=8080 DB_FILE=/data/chatly.db
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
CMD ["node", "--no-warnings", "server/index.js"]
