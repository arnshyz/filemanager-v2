
FROM node:20-alpine
WORKDIR /app
COPY package.json .
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm i
COPY . .
EXPOSE 3000 5173
CMD ["npm","run","dev"]
