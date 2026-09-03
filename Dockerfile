# Portable image for Railway, Fly.io, or any Docker host.
# Build:  docker build -t gradesense .
# Run:    docker run -p 4000:4000 -v gradesense-data:/data gradesense
FROM node:24-slim

WORKDIR /app

# Install first so the dependency layer is cached across source changes.
# The workspace manifests are needed for npm to resolve the monorepo.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .
RUN npm run build

# tsx (the runtime) and vite are devDependencies and are already installed
# above; setting NODE_ENV afterwards only affects library behaviour at runtime.
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 4000

CMD ["npm", "start"]
