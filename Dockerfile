# Usa Node.js versión 18 (compatible con better-sqlite3)
FROM node:18

# Crear carpeta de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar todo el proyecto
COPY . .

# Exponer puerto (Render usa este)
EXPOSE 3000

# Comando para iniciar servidor
CMD ["node", "server.js"]