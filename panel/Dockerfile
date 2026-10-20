# SPDX-License-Identifier: GPL-3.0-or-later
FROM golang:1.24-alpine AS build
ARG VERSION=dev
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/nikki-fleet-panel .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 10001 nf \
 && mkdir /data && chown nf /data
COPY --from=build /out/nikki-fleet-panel /usr/local/bin/nikki-fleet-panel
USER nf
ENV NF_DATA=/data NF_LISTEN=:8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["nikki-fleet-panel"]
