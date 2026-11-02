FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/taskboard.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
