# Lockkeeper as one container: the control plane only. Agents run in E2B sandboxes,
# never here. Mount a folder with lockkeeper.yml and .lockkeeper/.env at /data.
#
#   docker run --rm -it -v "$PWD:/data" ghcr.io/no-boolshit-ai/lockkeeper start

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: nothing the build needs runs code at install time.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE lockkeeper.example.yml ./
# A user without a login shell owns the data folder; the image runs as that user.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin lockkeeper \
  && mkdir /data && chown lockkeeper /data
USER lockkeeper
WORKDIR /data
VOLUME /data
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["start"]
