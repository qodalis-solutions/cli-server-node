FROM node:22-alpine AS build
WORKDIR /app

# Install build tools needed for node-pty native compilation
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
COPY packages/abstractions/package.json packages/abstractions/
COPY plugins/filesystem/package.json plugins/filesystem/
COPY plugins/filesystem-json/package.json plugins/filesystem-json/
COPY plugins/filesystem-sqlite/package.json plugins/filesystem-sqlite/
COPY plugins/filesystem-s3/package.json plugins/filesystem-s3/
COPY plugins/weather/package.json plugins/weather/
RUN npm install

COPY tsconfig.json ./
COPY packages/abstractions/ packages/abstractions/
RUN cd packages/abstractions && npx tsc

COPY plugins/ plugins/
RUN cd plugins/filesystem && npx tsc \
    && cd ../filesystem-json && npx tsc \
    && cd ../filesystem-sqlite && (npx tsc || true) \
    && cd ../filesystem-s3 && (npx tsc || true) \
    && cd ../weather && npx tsc

COPY src/ src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app

# node-pty needs these at runtime
RUN apk add --no-cache python3 make g++

COPY --from=build /app/dist/ dist/
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/packages/abstractions/dist/ packages/abstractions/dist/
COPY --from=build /app/packages/abstractions/package.json packages/abstractions/
COPY --from=build /app/plugins/ plugins/

ENV PORT=8047
EXPOSE 8047

CMD ["node", "dist/src/server.js"]
