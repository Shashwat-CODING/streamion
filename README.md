# Streamion

**Streamion** is a specialized Invidious-compatible backend service designed to run in environments with restricted network access or where VPN routing is required. It combines a **Go-based WireGuard Proxy** with a **Deno/TypeScript Application** in a single Docker container.

## Architecture

The project consists of two main components running concurrently:

1.  **WireGuard Proxy (Go):**
    -   **Role:** Acts as the network gateway/VPN tunnel.
    -   **Technology:** Uses userspace WireGuard (`netstack`) to establish a VPN connection without requiring privileged Docker capabilities (no `NET_ADMIN` needed).
    -   **Function:** Exposes a local HTTP proxy on `127.0.0.1:8080` that routes traffic through the WireGuard tunnel (e.g., via Cloudflare WARP).
    -   **Entrypoint:** `server.go`

2.  **Streamion Application (Deno/TypeScript):**
    -   **Role:** The main application logic (Invidious companion).
    -   **Technology:** Deno runtime.
    -   **Function:** Fetches data from external sources (like YouTube) by routing requests through the local WireGuard proxy.
    -   **Entrypoint:** `deno task dev` (via `src/main.ts` or as defined in `deno.json`).

## Directory Structure

All application files are located in the root directory:

-   `Dockerfile`: Multi-stage build for Go binaries and Deno environment.
-   `entrypoint.sh`: Orchestrates startup (starts Proxy in background -> waits for readiness -> starts Deno).
-   `server.go` & `warp.go`: Source code for the WireGuard proxy.
-   `src/`: TypeScript source code for Streamion.
-   `config/`: Configuration files (e.g., `config.toml`).
-   `deno.json` & `deno.lock`: Deno project configuration and lockfile.

## Configuration

### 1. WireGuard / Proxy
The proxy is configured via environment variables (usually set by Zeabur or your deployment platform):
-   `WIREGUARD_INTERFACE_PRIVATE_KEY`: Your WireGuard private key.
-   `WIREGUARD_PEER_PUBLIC_KEY`: Peer public key.
-   `WIREGUARD_PEER_ENDPOINT`: Peer endpoint (IP:Port).
-   `WIREGUARD_INTERFACE_ADDRESS`: Local interface IP (e.g., `172.16.0.2/32`).

### 2. Streamion App
The app is configured via `config/config.toml` and environment variables.
**Crucial Setting:** The app is pre-configured to use the local proxy:

```toml
[networking]
# ...
auto_proxy = false
vpn_source = 2
proxy = "http://127.0.0.1:8080"  # Points to the local Go proxy
```

## Running Locally

To run the entire stack locally using Docker:

1.  **Build the Image:**
    ```bash
    docker build -t streamion .
    ```

2.  **Run the Container:**
    ```bash
    docker run -p 8000:8000 -p 8080:8080 streamion
    ```
    *Note: You will need to provide valid WireGuard credentials as environment variables for the VPN to work.*

## Deployment

This project is optimized for deployment on platforms like Zeabur.
-   **Port:** The Deno app typically listens on port `8000`.
-   **Health Check:** The entrypoint script ensures the proxy is up before starting the app to prevent connection failures.
