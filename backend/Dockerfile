# Flask API of the Khmer Audio Annotation Tool.
#   docker build -t khmer-asr-backend backend
# PyTorch: the CPU build by default (small image). For an NVIDIA GPU build with
#   --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu128
FROM python:3.12-slim

ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

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

# torch first (its own index), then the rest; this layer is cached until requirements.txt changes
COPY requirements.txt .
RUN pip install torch --index-url ${TORCH_INDEX} \
    && pip install -r requirements.txt gunicorn

COPY . .

VOLUME ["/data", "/hf-cache"]
EXPOSE 5100

# ONE worker process: background jobs (imports, checks, pushes) live in its memory. Threads serve requests in
# parallel; long requests (recognition, uploads up to 1 GB) get a 15-minute timeout.
CMD ["sh", "-c", "exec gunicorn --workers 1 --threads 8 --timeout 900 --bind ${HOST}:${PORT} app:app"]
