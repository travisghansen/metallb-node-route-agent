FROM node:gallium-bullseye-slim AS build

ENV DEBIAN_FRONTEND=noninteractive

ARG TARGETPLATFORM
ARG BUILDPLATFORM

RUN echo "I am running build on $BUILDPLATFORM, building for $TARGETPLATFORM"

# install build deps
RUN apt-get update && apt-get install -y python3 make cmake gcc g++

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production
COPY . .

######################
# actual image
######################
FROM node:gallium-bullseye-slim

LABEL org.opencontainers.image.source https://github.com/travisghansen/metallb-node-route-agent

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

ARG TARGETPLATFORM
ARG BUILDPLATFORM

RUN echo "I am running on final $BUILDPLATFORM, building for $TARGETPLATFORM"

RUN apt-get update && apt-get install -y iproute2 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app

WORKDIR /app

CMD [ "npm", "run", "start" ]
