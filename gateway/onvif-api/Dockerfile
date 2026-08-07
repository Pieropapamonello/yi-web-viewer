FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./

RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "server.js"]
