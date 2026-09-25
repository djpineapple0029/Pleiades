FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Populates ../server/static per vite.config.js's outDir. Caddy serves this
# under /pleiades (docker-compose.yml), so the asset URLs need that prefix.
ENV ATLASMAP_BASE=/pleiades/
RUN npm run build

FROM python:3.13-slim
WORKDIR /app
RUN pip install --no-cache-dir flask cryptography waitress
COPY server/ ./server/
COPY --from=frontend-build /app/server/static ./server/static
COPY docker_serve.py .

ENV PORT=5051
CMD ["python", "docker_serve.py"]
