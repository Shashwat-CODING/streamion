FROM golang:bookworm as builder
WORKDIR /go/src
EXPOSE 8080

# Install git first as it is required for go mod tidy
RUN apt-get update && apt-get install -y git build-essential

# Copy everything first
COPY go.mod go.sum ./
COPY warp.go server.go ./

# Resolution ambiguity fix: Explicitly fetch the main module and tidy
RUN go mod download && go mod tidy

# Build binaries
RUN CGO_ENABLED=0 GOOS=linux \
    go build -a -installsuffix cgo -ldflags '-s' -o warp warp.go && \
    go build -a -installsuffix cgo -ldflags '-s' -o server server.go

FROM ubuntu:22.04

# Copy binaries
COPY --from=builder /go/src/warp /usr/local/bin/
COPY --from=builder /go/src/server /usr/local/bin/
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

COPY entrypoint.sh   /usr/local/bin/

# Install dependencies and Deno
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    ca-certificates \
    unzip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://deno.land/x/install/install.sh | sh \
    && mv /root/.deno/bin/deno /usr/local/bin/deno \
    # Install cloudflared
    && curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/entrypoint.sh

# Copy Deno App
WORKDIR /app
COPY deno.json deno.lock compile.env grafana_dashboard.json ./
COPY config ./config
COPY src ./src

ENV         DAEMON_MODE                     false
ENV         PROXY_UP                        ""
ENV         PROXY_PORT                      "8080"
ENV         PROXY_USER                      ""
ENV         PROXY_PASS                      ""
ENV         QUICK_TUNNEL                    "false"
ENV         TUNNEL_TOKEN                    ""
ENV         WIREGUARD_UP                    ""
ENV         WIREGUARD_CONFIG                ""
ENV         WIREGUARD_INTERFACE_PRIVATE_KEY ""
ENV         WIREGUARD_INTERFACE_DNS         "1.1.1.1"
ENV         WIREGUARD_INTERFACE_ADDRESS     ""
ENV         WIREGUARD_PEER_PUBLIC_KEY       ""
ENV         WIREGUARD_PEER_ALLOWED_IPS      "0.0.0.0/0"
ENV         WIREGUARD_PEER_ENDPOINT         ""

ENTRYPOINT  [ "entrypoint.sh" ]
