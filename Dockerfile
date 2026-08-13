FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:vps

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/client ./dist/client
COPY --from=build /app/server ./server
COPY --from=build /app/sites/worker.js ./sites/worker.js
COPY --from=build /app/sites/access-control.js ./sites/access-control.js
USER node
COPY --from=build /app/sites/lib ./sites/lib
EXPOSE 3000
CMD ["node", "server/index.js"]
