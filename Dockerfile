FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY test ./test
COPY index.html app.js styles.css manifest.webmanifest icon.svg ./
EXPOSE 8787
CMD ["node", "server.js"]
