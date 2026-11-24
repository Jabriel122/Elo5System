FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# dependências primeiro (aproveita o cache do Docker)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js db.js resetar-senha.js ./
COPY public ./public

# pasta do banco JSON (usuários); o volume do compose guarda ela fora do container
RUN mkdir -p /app/data && chown node:node /app/data

# o usuário "node" já existe na imagem: não roda como root
USER node
EXPOSE 3000
CMD ["node", "server.js"]
