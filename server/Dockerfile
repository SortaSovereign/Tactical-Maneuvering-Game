# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY server/package*.json server/
RUN npm ci --omit=dev -w server
COPY server ./server
WORKDIR /app/server
RUN npm run build

# Run stage
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=build /app/server/package*.json ./
COPY --from=build /app/server/dist ./dist
RUN npm ci --omit=dev
EXPOSE 3001
CMD ["node", "dist/index.js"]
