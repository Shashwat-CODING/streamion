#!/usr/bin/env bash
set -ex

echo "[ENTRYPOINT] Starting WireGuard HTTP Proxy"

# Check if WireGuard config should be generated
if [[ -z "${WIREGUARD_INTERFACE_PRIVATE_KEY}" ]]; then
    echo "[ENTRYPOINT] Generating Cloudflare Warp configuration..."
    
    # Run warp binary to generate config
    WARP_OUTPUT=$(warp)
    
    # Parse the warp output to extract config values
    export WIREGUARD_INTERFACE_PRIVATE_KEY=$(echo "$WARP_OUTPUT" | grep "PrivateKey" | awk '{print $3}')
    export WIREGUARD_INTERFACE_ADDRESS=$(echo "$WARP_OUTPUT" | grep "Address" | awk '{print $3}')
    export WIREGUARD_PEER_PUBLIC_KEY=$(echo "$WARP_OUTPUT" | grep "PublicKey" | awk '{print $3}')
    export WIREGUARD_PEER_ENDPOINT=$(echo "$WARP_OUTPUT" | grep "Endpoint" | awk '{print $3}')
    export WIREGUARD_INTERFACE_DNS="${WIREGUARD_INTERFACE_DNS:-1.1.1.1}"
    
    echo "[ENTRYPOINT] Warp config generated successfully"
else
    echo "[ENTRYPOINT] Using provided WireGuard configuration"
fi

# Start the proxy server in the background
echo "[ENTRYPOINT] Starting HTTP proxy server (internal)..."
server &
SERVER_PID=$!

# Wait for proxy to start
echo "[ENTRYPOINT] Waiting for proxy to be ready on port 8080..."
while ! curl -v http://127.0.0.1:8080/ 2>&1 | grep "Proxy Running"; do
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "[FATAL] Server process exited unexpectedly!"
        wait $SERVER_PID
        exit 1
    fi
    echo "[ENTRYPOINT] Proxy not ready yet... retrying in 1s"
    sleep 1
done
echo "[ENTRYPOINT] Proxy is ready!"

# Start Proxy Check
echo "[ENTRYPOINT] Checking proxy connection..."
curl -s -x http://127.0.0.1:8080 https://cloudflare.com/cdn-cgi/trace
echo ""
echo "[ENTRYPOINT] Proxy check complete."

# Start Cloudflare Tunnel
if [[ -n "${TUNNEL_TOKEN}" ]]; then
    echo "[ENTRYPOINT] Starting Cloudflare Tunnel with provided token..."
    cloudflared tunnel --no-autoupdate run --token "${TUNNEL_TOKEN}" &
    echo "[ENTRYPOINT] Cloudflare Tunnel started in background"
elif [[ "${QUICK_TUNNEL}" == "true" ]]; then
    echo "[ENTRYPOINT] Starting Cloudflare Quick Tunnel (random domain)..."
    # Port 8000 is the Deno app port
    cloudflared tunnel --no-autoupdate --url http://localhost:8000 &
    echo "[ENTRYPOINT] Cloudflare Quick Tunnel started in background"
    echo "[ENTRYPOINT] Check logs for your random 'trycloudflare.com' URL"
else
    echo "[ENTRYPOINT] No TUNNEL_TOKEN or QUICK_TUNNEL=true provided, skipping Cloudflare Tunnel"
fi

# Start Streamion
echo "[ENTRYPOINT] Starting Streamion..."
exec deno task dev
