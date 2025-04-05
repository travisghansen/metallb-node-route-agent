# docker buildx build --platform linux/amd64,linux/arm64 .
FROM node:iron-bookworm-slim AS build

ENV DEBIAN_FRONTEND=noninteractive

ARG TARGETPLATFORM
ARG BUILDPLATFORM

RUN echo "I am running build on $BUILDPLATFORM, building for $TARGETPLATFORM"

# install build deps
#RUN apt-get update && apt-get install -y python3 make cmake gcc g++

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production
COPY . .

######################
# actual image
######################
FROM node:iron-bookworm-slim

LABEL org.opencontainers.image.source https://github.com/travisghansen/metallb-node-route-agent

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

ARG TARGETPLATFORM
ARG BUILDPLATFORM

RUN echo "I am running on final $BUILDPLATFORM, building for $TARGETPLATFORM"

RUN apt-get update && \
    cd ~ && \
    apt-get install -y iproute2 xz-utils conntrack ipset iptables wget curl jq less ipvsadm telnet dnsutils && \
    wget -c https://xyne.dev/projects/idemptables/src/idemptables-2012.tar.xz -O - | tar -Jxv && \
    install -o root -g root -m 0755 idemptables-2012/idemptables /usr/sbin/idemptables && \
    rm -rf idemptables-2012/ && \
    sed -i 's:#!/bin/sh:#!/bin/bash:g' /usr/sbin/idemptables && \
    curl -LO https://dl.k8s.io/release/v1.27.3/bin/linux/amd64/kubectl && \
    install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl && \
    rm -rf kubectl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app

WORKDIR /app

CMD [ "npm", "run", "start" ]
