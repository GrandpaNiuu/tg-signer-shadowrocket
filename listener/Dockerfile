FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN useradd --create-home --uid 10001 listener

COPY runner/requirements.txt /app/runner/requirements.txt
COPY listener/requirements.txt /app/listener/requirements.txt
RUN python -m pip install --no-cache-dir --requirement /app/listener/requirements.txt

COPY listener /app/listener

USER listener

CMD ["python", "-m", "listener"]
