FROM node:20-alpine

WORKDIR /app

# Instala dependências
COPY package*.json ./
RUN npm install --omit=dev

# Copia código-fonte
COPY . .

# Cria pasta de dados
RUN mkdir -p data/baileys_auth

EXPOSE 8000

ENV PORT=8000
ENV NODE_ENV=production

CMD ["npm", "start"]
