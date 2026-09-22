# Polymind en contenedor: el motor, el panel compilado y —esto es lo importante— un NAVEGADOR.
#
# Por qué una imagen propia y no el runtime nativo del host: la evidencia visual necesita Chromium
# (el servidor abre el artefacto headless, mide el PNG y exige firma sobre él). En un runtime nativo
# sin navegador eso queda «no comprobado», y el juicio de lo que se ve se pierde. Acá viene dentro.
#
# Detalles que no son adorno:
#   · `chromium` de Debian trae sus bibliotecas (X, NSS, fuentes base). Sin ellas el binario existe y
#     no arranca: el error típico es «error while loading shared libraries».
#   · Se corre como el usuario `node` (no root): así el navegador no necesita ceder el sandbox, que
#     es lo que obliga `--no-sandbox` cuando un contenedor corre como root.
#   · El cliente CDP usa el WebSocket nativo de Node: hace falta Node 22+ (la imagen ya lo trae).
#   · La memoria durable clona y publica salas en Git: sin el binario `git`, el servidor arranca
#     pero no rehidrata nada después de un redespliegue.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    git \
    fonts-dejavu-core \
    fonts-liberation \
    fontconfig \
  && rm -rf /var/lib/apt/lists/*

# El motor busca el navegador sola, pero decirlo aquí evita cualquier duda y cualquier PATH raro.
ENV AGORA_CHROME=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .

# El panel (interfaz estática) se compila en la imagen: el servidor sirve `app/dist`.
RUN npm run build

# Los datos de las salas viven fuera de la imagen (volumen o sistema de ficheros del host).
ENV PORT=10000
ENV AGORA_DATA=/home/node/agora-data
RUN mkdir -p /home/node/agora-data && chown -R node:node /app /home/node/agora-data
USER node

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
