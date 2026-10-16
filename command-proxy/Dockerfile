FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
ARG TARGETARCH
WORKDIR /src
COPY main.go .
RUN go mod init garage-command-proxy && go get github.com/teslamotors/vehicle-command@a4b43c1eff0e09d77deb9f2dce97031141fe8c8a && go mod tidy
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /command-proxy .
FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 garage
COPY --from=build /command-proxy /usr/local/bin/command-proxy
COPY TESLA-LICENSE NOTICE /usr/share/licenses/tesla-garage/
USER garage
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/command-proxy"]
