FROM ubuntu:22.04

# Expose proxy port
EXPOSE 8080

# Configure Go env
ENV GO_VERSION=1.21.6
ENV PATH=$PATH:/usr/local/go/bin:/root/go/bin

# Install runtime dependencies, Deno, and Go
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    ca-certificates \
    unzip \
    ffmpeg \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/* \
    # Install Go
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o go.tar.gz \
    && tar -C /usr/local -xzf go.tar.gz \
    && rm go.tar.gz \
    # Install Deno
    && curl -fsSL https://deno.land/x/install/install.sh | sh \
    && mv /root/.deno/bin/deno /usr/local/bin/deno

# Set Go workdir
WORKDIR /go/src

# Copy over Go files
COPY go.mod go.sum ./
COPY warp.go server.go ./

# Download dependencies and build the proxy binaries
RUN go mod download && go mod tidy \
    && CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -ldflags '-s' -o /usr/local/bin/warp warp.go \
    && CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -ldflags '-s' -o /usr/local/bin/server server.go

# Copy App files
WORKDIR /app
COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY deno.json deno.lock compile.env grafana_dashboard.json ./
COPY config ./config
COPY src ./src

# Environment variables
ENV DAEMON_MODE=false
ENV PROXY_UP=""
ENV PROXY_PORT=8080
ENV PROXY_USER=""
ENV PROXY_PASS=""
ENV WIREGUARD_UP=""
ENV WIREGUARD_CONFIG=""
ENV WIREGUARD_INTERFACE_PRIVATE_KEY=""
ENV WIREGUARD_INTERFACE_DNS="1.1.1.1"
ENV WIREGUARD_INTERFACE_ADDRESS=""
ENV WIREGUARD_PEER_PUBLIC_KEY=""
ENV WIREGUARD_PEER_ALLOWED_IPS="0.0.0.0/0"
ENV WIREGUARD_PEER_ENDPOINT=""

ENTRYPOINT [ "entrypoint.sh" ]