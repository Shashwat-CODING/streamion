package main

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/caarlos0/env"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type params struct {
	User     string `env:"PROXY_USER" envDefault:""`
	Password string `env:"PROXY_PASS" envDefault:""`
	Port     string `env:"PORT" envDefault:"8080"`
	// WireGuard Params
	WgPrivateKey    string `env:"WIREGUARD_INTERFACE_PRIVATE_KEY"`
	WgAddress       string `env:"WIREGUARD_INTERFACE_ADDRESS"` // e.g., 10.0.0.2/32
	WgPeerPublicKey string `env:"WIREGUARD_PEER_PUBLIC_KEY"`
	WgPeerEndpoint  string `env:"WIREGUARD_PEER_ENDPOINT"`     // e.g., 1.2.3.4:51820
	WgDNS           string `env:"WIREGUARD_INTERFACE_DNS" envDefault:"1.1.1.1"`
}

var tnet *netstack.Net

func handleTunneling(w http.ResponseWriter, r *http.Request) {
	dest := r.URL.Host
	if dest == "" {
		dest = r.Host
	}

	var dest_conn net.Conn
	var err error

	if tnet == nil {
		dest_conn, err = net.DialTimeout("tcp", dest, 10*time.Second)
	} else {
		// Use tnet.Dial to connect through WireGuard
		dest_conn, err = tnet.Dial("tcp", dest)
	}

	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}
	client_conn, _, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return // Return early if hijack failed
	}
	go transfer(dest_conn, client_conn)
	go transfer(client_conn, dest_conn)
}

func transfer(destination io.WriteCloser, source io.ReadCloser) {
	defer destination.Close()
	defer source.Close()
	io.Copy(destination, source)
}

func handleHTTP(w http.ResponseWriter, r *http.Request) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	
	if tnet != nil {
		// Use tnet.DialContext for HTTP requests
		transport.DialContext = tnet.DialContext
	}

	resp, err := transport.RoundTrip(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()
	copyHeader(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func handleDebug(w http.ResponseWriter, r *http.Request) {
	if tnet == nil {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("Error: WireGuard not initialized (Direct Mode)"))
		return
	}

	client := &http.Client{
		Transport: &http.Transport{
			DialContext: tnet.DialContext,
		},
		Timeout: 10 * time.Second,
	}

	resp, err := client.Get("http://ifconfig.me")
	if err != nil {
		log.Printf("[DEBUG] VPN Test Failed: %v", err)
		http.Error(w, fmt.Sprintf("VPN Connection Failed: %v", err), http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()
	
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read response: %v", err), http.StatusInternalServerError)
		return
	}
	
	log.Printf("[DEBUG] VPN Test Success. IP: %s", string(body))
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(fmt.Sprintf("VPN Connected! Public IP: %s", string(body))))
}

func copyHeader(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

func startWireGuard(cfg params) error {
	if cfg.WgPrivateKey == "" || cfg.WgPeerEndpoint == "" {
		log.Println("[INFO] WireGuard config missing, running in DIRECT mode (no VPN)")
		return nil
	}

	log.Println("[INFO] Initializing Userspace WireGuard...")

	localIPs := []netip.Addr{}
	if cfg.WgAddress != "" {
		// Handle CIDR notation if present (e.g., 10.0.0.2/32)
		addrStr := strings.Split(cfg.WgAddress, "/")[0]
		addr, err := netip.ParseAddr(addrStr)
		if err == nil {
			localIPs = append(localIPs, addr)
			log.Printf("[INFO] Local VPN IP: %s", addr)
		} else {
			log.Printf("[WARN] Failed to parse local IP: %v", err)
		}
	}
	
	dnsIP, err := netip.ParseAddr(cfg.WgDNS)
	if err != nil {
		log.Printf("[WARN] Failed to parse DNS IP, using default: %v", err)
		dnsIP, _ = netip.ParseAddr("1.1.1.1")
	}
	log.Printf("[INFO] DNS Server: %s", dnsIP)

	log.Println("[INFO] Creating virtual network interface...")
	tunDev, tnetInstance, err := netstack.CreateNetTUN(
		localIPs,
		[]netip.Addr{dnsIP},
		1420,
	)
	if err != nil {
		return fmt.Errorf("failed to create TUN: %w", err)
	}
	tnet = tnetInstance
	log.Println("[INFO] Virtual TUN device created successfully")

	log.Println("[INFO] Initializing WireGuard device...")
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	
	log.Printf("[INFO] Configuring peer endpoint: %s", cfg.WgPeerEndpoint)

	// Convert keys from Base64 to Hex
	// wireguard-go expects hex keys in UAPI, but inputs are usually Base64
	privateKeyHex, err := base64ToHex(cfg.WgPrivateKey)
	if err != nil {
		return fmt.Errorf("invalid private key (base64 decode failed): %w", err)
	}

	publicKeyHex, err := base64ToHex(cfg.WgPeerPublicKey)
	if err != nil {
		return fmt.Errorf("invalid peer public key (base64 decode failed): %w", err)
	}

	uapi := fmt.Sprintf(`private_key=%s
public_key=%s
endpoint=%s
allowed_ip=0.0.0.0/0
`, privateKeyHex, publicKeyHex, cfg.WgPeerEndpoint)

	if err := dev.IpcSet(uapi); err != nil {
		return fmt.Errorf("failed to configure device: %w", err)
	}
	log.Println("[INFO] WireGuard peer configured")
	
	if err := dev.Up(); err != nil {
		return fmt.Errorf("failed to bring up device: %w", err)
	}

	log.Println("[SUCCESS] WireGuard interface is UP - All traffic will route through VPN")
	return nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.Println("[STARTUP] Initializing HTTP Proxy with Userspace WireGuard")
	
	cfg := params{}
	if err := env.Parse(&cfg); err != nil {
		log.Printf("[WARN] Config parse warning: %+v\n", err)
	}

	log.Printf("[CONFIG] Proxy Port: %s", cfg.Port)
	if cfg.User != "" {
		log.Printf("[CONFIG] Authentication: Enabled (user: %s)", cfg.User)
	} else {
		log.Println("[CONFIG] Authentication: Disabled")
	}

	if err := startWireGuard(cfg); err != nil {
		log.Fatalf("[FATAL] Failed to start WireGuard: %v", err)
	}

	log.Printf("[STARTUP] Starting HTTP proxy server on port %s\n", cfg.Port)

	server := &http.Server{
		Addr: ":" + cfg.Port,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if cfg.User != "" && cfg.Password != "" {
				user, pass, ok := r.BasicAuth()
				if !ok || user != cfg.User || pass != cfg.Password {
					log.Printf("[AUTH] Unauthorized access attempt from %s", r.RemoteAddr)
					w.Header().Set("Proxy-Authenticate", `Basic realm="Proxy"`)
					http.Error(w, "Unauthorized", http.StatusProxyAuthRequired)
					return
				}
			}
			
			// Handle CONNECT (HTTPS tunnel)
			if r.Method == http.MethodConnect {
				log.Printf("[CONNECT] %s -> %s", r.RemoteAddr, r.Host)
				handleTunneling(w, r)
				return
			}
			
			// Direct requests to the proxy server (Health check & Debug)
			// We check r.URL.Host == "" which means it's a direct request, not a proxy request
			if r.URL.Host == "" {
				if r.URL.Path == "/" {
					log.Printf("[HEALTH] Health check from %s", r.RemoteAddr)
					w.WriteHeader(http.StatusOK)
					if tnet != nil {
						w.Write([]byte("Proxy Running via Userspace WireGuard"))
					} else {
						w.Write([]byte("Proxy Running in Direct Mode (No VPN)"))
					}
					return
				}
				
				if r.URL.Path == "/debug" {
					log.Printf("[DEBUG] Debug check from %s", r.RemoteAddr)
					handleDebug(w, r)
					return
				}
			}

			// Proxy HTTP requests
			log.Printf("[HTTP] %s %s -> %s", r.Method, r.RemoteAddr, r.URL.String())
			handleHTTP(w, r)
		}),
	}
	
	log.Println("[READY] Proxy server is ready to accept connections")
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("[FATAL] Server error: %v", err)
	}
}

func base64ToHex(b64 string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(decoded), nil
}
