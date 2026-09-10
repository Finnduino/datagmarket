FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8791
EXPOSE 8791

USER node
CMD ["node", "src/server.js"]
