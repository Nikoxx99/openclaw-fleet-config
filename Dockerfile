# OpenClaw Fleet — extiende la imagen oficial.
#
# Capa minima sobre `ghcr.io/openclaw/openclaw:latest` que añade:
#   - deps de sistema para las skills privadas (ffmpeg, tesseract, poppler, imagemagick)
#   - venv Python con libs (pyyaml, Pillow, pdfplumber, langdetect)
#   - entrypoint que clona fleet-config en runtime y compila la config del agente
#
# El mismo container corre cualquier agente declarado en `agents/<id>.yaml`,
# diferenciado por la env var AGENT_ID.

FROM ghcr.io/openclaw/openclaw:latest

USER root

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    VENV_DIR=/opt/venv \
    FLEET_DIR=/opt/fleet \
    HOOKS_DIR=/opt/hooks \
    OPENCLAW_HOME=/home/node/.openclaw \
    OPENCLAW_BUNDLED_SKILLS_DIR=/home/node/.openclaw/skills

# Sistema: ffmpeg (audio/concat), tesseract+spa+eng (OCR), poppler (pdftoppm),
# imagemagick (identify para sensitive-image-gate), python+venv, jq.
# git + ca-certificates ya estan en la imagen base.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      tesseract-ocr tesseract-ocr-spa tesseract-ocr-eng \
      poppler-utils \
      imagemagick \
      python3 python3-venv python3-pip \
      jq \
    && rm -rf /var/lib/apt/lists/*

# Permitir que ImageMagick lea PDFs (algunas distros lo deshabilitan por CVE-2016-3714).
RUN sed -i 's|<policy domain="coder" rights="none" pattern="PDF" />|<policy domain="coder" rights="read\|write" pattern="PDF" />|' \
      /etc/ImageMagick-6/policy.xml || true

# Venv para deps Python (limpio, no toca system Python). Recomendado en prod.
RUN python3 -m venv $VENV_DIR && \
    $VENV_DIR/bin/pip install --no-cache-dir --upgrade pip && \
    $VENV_DIR/bin/pip install --no-cache-dir \
      pyyaml \
      pillow \
      pillow-heif \
      pdfplumber \
      pymupdf \
      langdetect

ENV PATH="$VENV_DIR/bin:$PATH"

# Entrypoint y healthcheck del fleet.
COPY entrypoint.sh /usr/local/bin/fleet-entrypoint.sh
COPY scripts/healthcheck.sh /usr/local/bin/fleet-healthcheck.sh
RUN chmod +x /usr/local/bin/fleet-entrypoint.sh /usr/local/bin/fleet-healthcheck.sh && \
    install -d -m 0755 -o node -g node $FLEET_DIR $HOOKS_DIR && \
    install -d -m 0700 -o node -g node /var/log/agente

# Coolify hace healthcheck cada 30s. Override del HEALTHCHECK de la imagen base
# para chequear el endpoint real del gateway (puerto 18789, /healthz).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD /usr/local/bin/fleet-healthcheck.sh

# Volver al usuario node (lo que la imagen oficial usa por defecto).
USER node

EXPOSE 18789

ENTRYPOINT ["/usr/local/bin/fleet-entrypoint.sh"]
