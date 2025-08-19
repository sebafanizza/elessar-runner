FROM node:20-alpine
WORKDIR /app

# copia i manifest
COPY package*.json ./

# installa dipendenze (senza dev)
RUN npm install --omit=dev

# copia il resto del codice
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm","start"]
