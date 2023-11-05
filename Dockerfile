FROM node:20

WORKDIR /server

COPY package*.json ./

RUN npm i

COPY . .

ENV SERVER_PORT=9090

ENV CLIENT_PORT=9091

ENV DB_PORT=3306

ENV DB_CONNECTION=mysql

ENV DB_HOST=127.0.0.1

ENV DB_DATABASE=who-is-it

ENV DB_USERNAME=root

ENV DB_PASSWORD=123456789

EXPOSE 9090

EXPOSE 9091

CMD ["node", "."]