# Single-image build: compile the React bundle, then serve it and the API
# from one FastAPI process. The simulation is a long-lived ticking loop with
# a WebSocket attached, so it needs a persistent container -- this will not
# run on serverless function hosting.

# ---- stage 1: build the frontend ----
FROM node:20-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- stage 2: python runtime ----
FROM python:3.11-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    V2X_FRONTEND_DIST=/app/frontend_dist

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=frontend /build/dist /app/frontend_dist

# Hosts inject the port they want us on.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
