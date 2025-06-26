###
# docker build -t chatproxy-container .
# docker compose up --build

#ARG NODE_VERSION=23.1
ARG NODE_VERSION=18

FROM node:${NODE_VERSION}-alpine AS base

WORKDIR /

COPY ca-certificates/* /usr/local/share/ca-certificates/

RUN apk add --no-cache ca-certificates
RUN update-ca-certificates

WORKDIR /

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# 
#RUN chown -R node /usr/src/app

EXPOSE 3300

CMD [ "npm", "start" ]
