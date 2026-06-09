FROM node:20-slim

WORKDIR /app

# Deps zuerst (Layer-Caching)
COPY package.json ./
RUN npm install

# Source
COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
