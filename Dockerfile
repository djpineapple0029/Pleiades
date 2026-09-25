FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# keymap.js and settings.js import the settings schema from the server package.
COPY server/settings_schema.json ../server/settings_schema.json
# Populates ../server/static per vite.config.js's outDir. Caddy serves this
# under /pleiades (docker-compose.yml), so the asset URLs need that prefix.
ENV ATLASMAP_BASE=/pleiades/
RUN npm run build

FROM python:3.13-slim
WORKDIR /app
RUN pip install --no-cache-dir flask cryptography waitress tomlkit
COPY server/ ./server/
COPY --from=frontend-build /app/server/static ./server/static
COPY docker_serve.py .

ENV PORT=5051
# The admin panel's config lives on the volume so a rebuild keeps it. First
# start writes it with a generated admin password: `docker compose logs pleiades`.
# One proxy (Caddy) sits in front, so the client address is the last
# X-Forwarded-For hop; this seeds admin.trusted_proxies in a new config only.
ENV ATLASMAP_CONFIG=/data/atlasmap.toml
ENV ATLASMAP_TRUSTED_PROXIES=1
VOLUME /data
CMD ["python", "docker_serve.py"]
