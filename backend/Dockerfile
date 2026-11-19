# Flask API of the Khmer Audio Annotation Tool.
#   docker build -t khmer-asr-backend backend
# The ASR model runs with ONNX Runtime on the CPU (26M parameters, no PyTorch needed).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOST=0.0.0.0 \
    PORT=5100 \
    ASR_DATA_DIR=/data \
    HF_HOME=/hf-cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# this layer is cached until requirements.txt changes
COPY requirements.txt .
RUN pip install -r requirements.txt gunicorn

COPY . .

VOLUME ["/data", "/hf-cache"]
EXPOSE 5100

# ONE worker process: background jobs (imports, checks, pushes) live in its memory. Threads serve requests in
# parallel; long requests (recognition, uploads up to 1 GB) get a 15-minute timeout.
CMD ["sh", "-c", "exec gunicorn --workers 1 --threads 8 --timeout 900 --bind ${HOST}:${PORT} app:app"]
