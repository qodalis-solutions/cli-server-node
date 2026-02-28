FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

WORKDIR /app/demo
COPY demo/package.json ./
COPY demo/src/ src/
RUN npm install

FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/dist/ dist/
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/

COPY --from=build /app/demo/src/ demo/src/
COPY --from=build /app/demo/package.json demo/
COPY --from=build /app/demo/node_modules/ demo/node_modules/

ENV PORT=8047
EXPOSE 8047

CMD ["npx", "tsx", "demo/src/index.ts"]
