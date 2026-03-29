# AWS App Runner: build from repo root with: docker build -f py/Dockerfile py
FROM python:3.12-slim-bookworm
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ingest.py profile_catalog.py .

# App Runner sets PORT (default 8080)
ENV PORT=8080
EXPOSE 8080
CMD sh -c "exec uvicorn server:app --host 0.0.0.0 --port ${PORT}"
