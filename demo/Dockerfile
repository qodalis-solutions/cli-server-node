FROM node:22-alpine AS build
WORKDIR /app

# Install build tools needed for node-pty native compilation
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
COPY packages/abstractions/package.json packages/abstractions/
RUN npm install

COPY tsconfig.json ./
COPY packages/abstractions/tsconfig.json packages/abstractions/tsconfig.json
COPY packages/abstractions/src/ packages/abstractions/src/
RUN cd packages/abstractions && npx tsc

COPY src/ src/
RUN npm run build

WORKDIR /app/demo
COPY demo/package.json ./
COPY demo/src/ src/
RUN npm install

FROM node:22-alpine
WORKDIR /app

# node-pty needs these at runtime
RUN apk add --no-cache python3 make g++

COPY --from=build /app/dist/ dist/
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/packages/abstractions/dist/ packages/abstractions/dist/
COPY --from=build /app/packages/abstractions/package.json packages/abstractions/

COPY --from=build /app/demo/src/ demo/src/
COPY --from=build /app/demo/package.json demo/
COPY --from=build /app/demo/node_modules/ demo/node_modules/

ENV PORT=8047
EXPOSE 8047

CMD ["npx", "tsx", "demo/src/index.ts"]
