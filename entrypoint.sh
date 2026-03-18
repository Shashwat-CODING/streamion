#!/usr/bin/env bash
set -ex

echo "[ENTRYPOINT] Starting WireGuard SOCKS5 Proxy"

if [[ -z "${WIREGUARD_INTERFACE_PRIVATE_KEY}" ]]; then
    echo "[ENTRYPOINT] Generating Cloudflare Warp configuration..."
    
    WARP_OUTPUT=$(warp)
    
    export WIREGUARD_INTERFACE_PRIVATE_KEY=$(echo "$WARP_OUTPUT" | grep "PrivateKey" | awk '{print $3}')
    export WIREGUARD_INTERFACE_ADDRESS=$(echo "$WARP_OUTPUT" | grep "Address" | awk '{print $3}')
    export WIREGUARD_PEER_PUBLIC_KEY=$(echo "$WARP_OUTPUT" | grep "PublicKey" | awk '{print $3}')
    export WIREGUARD_PEER_ENDPOINT=$(echo "$WARP_OUTPUT" | grep "Endpoint" | awk '{print $3}')
    export WIREGUARD_INTERFACE_DNS="${WIREGUARD_INTERFACE_DNS:-1.1.1.1}"
    
    echo "[ENTRYPOINT] Warp config generated successfully"
else
    echo "[ENTRYPOINT] Using provided WireGuard configuration"
fi

echo "[ENTRYPOINT] Starting SOCKS5 proxy server (internal)..."
server &
SERVER_PID=$!

echo "[ENTRYPOINT] Waiting for proxy to be ready on port 1080..."
until nc -z 127.0.0.1 1080 2>/dev/null; do
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "[FATAL] Server process exited unexpectedly!"
        wait $SERVER_PID
        exit 1
    fi
    echo "[ENTRYPOINT] Proxy not ready yet... retrying in 1s"
    sleep 1
done

echo "[ENTRYPOINT] Proxy is ready!"

echo "[ENTRYPOINT] Checking proxy connection..."
curl -s --max-time 15 --socks5 127.0.0.1:1080 https://cloudflare.com/cdn-cgi/trace
echo ""
echo "[ENTRYPOINT] Proxy check complete."

echo "[ENTRYPOINT] Starting Streamion..."
exec deno task dev
