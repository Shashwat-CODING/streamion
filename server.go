package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
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
	Port     string `env:"PORT" envDefault:"1080"`
	// WireGuard Params
	WgPrivateKey    string `env:"WIREGUARD_INTERFACE_PRIVATE_KEY"`
	WgAddress       string `env:"WIREGUARD_INTERFACE_ADDRESS"` // e.g., 10.0.0.2/32
	WgPeerPublicKey string `env:"WIREGUARD_PEER_PUBLIC_KEY"`
	WgPeerEndpoint  string `env:"WIREGUARD_PEER_ENDPOINT"` // e.g., 1.2.3.4:51820
	WgDNS           string `env:"WIREGUARD_INTERFACE_DNS" envDefault:"1.1.1.1"`
}

// SOCKS5 constants
const (
	socks5Version = byte(0x05)

	// Auth methods
	authNone     = byte(0x00)
	authPassword = byte(0x02)
	authNoAccept = byte(0xFF)

	// Commands
	cmdConnect = byte(0x01)

	// Address types
	addrIPv4   = byte(0x01)
	addrDomain = byte(0x03)
	addrIPv6   = byte(0x04)

	// Reply codes
	repSuccess         = byte(0x00)
	repFailure         = byte(0x01)
	repNotAllowed      = byte(0x02)
	repNetUnreachable  = byte(0x03)
	repHostUnreachable = byte(0x04)
	repConnRefused     = byte(0x05)
	repCmdNotSupported = byte(0x07)
	repAddrNotSupported = byte(0x08)
)

var tnet *netstack.Net

// handleSocks5 handles a single SOCKS5 client connection.
func handleSocks5(conn net.Conn, cfg params) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(30 * time.Second))

	// --- Step 1: Client greeting ---
	// +----+----------+----------+
	// |VER | NMETHODS | METHODS  |
	// +----+----------+----------+
	// | 1  |    1     | 1-255    |
	// +----+----------+----------+
	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil {
		log.Printf("[SOCKS5] Failed to read greeting header: %v", err)
		return
	}
	if header[0] != socks5Version {
		log.Printf("[SOCKS5] Unsupported SOCKS version: %d", header[0])
		return
	}
	nMethods := int(header[1])
	methods := make([]byte, nMethods)
	if _, err := io.ReadFull(conn, methods); err != nil {
		log.Printf("[SOCKS5] Failed to read methods: %v", err)
		return
	}

	// --- Step 2: Auth negotiation ---
	useAuth := cfg.User != "" && cfg.Password != ""
	if useAuth {
		// Check client supports username/password auth (0x02)
		supported := false
		for _, m := range methods {
			if m == authPassword {
				supported = true
				break
			}
		}
		if !supported {
			conn.Write([]byte{socks5Version, authNoAccept})
			log.Printf("[SOCKS5] Client does not support password auth, rejecting")
			return
		}
		conn.Write([]byte{socks5Version, authPassword})

		// Sub-negotiation: username/password (RFC 1929)
		// +----+------+----------+------+----------+
		// |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
		// +----+------+----------+------+----------+
		// | 1  |  1   | 1 to 255 |  1   | 1 to 255 |
		// +----+------+----------+------+----------+
		authHeader := make([]byte, 2)
		if _, err := io.ReadFull(conn, authHeader); err != nil {
			log.Printf("[SOCKS5] Failed to read auth sub-negotiation: %v", err)
			return
		}
		// authHeader[0] is sub-negotiation version (should be 0x01)
		uLen := int(authHeader[1])
		uName := make([]byte, uLen)
		if _, err := io.ReadFull(conn, uName); err != nil {
			return
		}
		pLenBuf := make([]byte, 1)
		if _, err := io.ReadFull(conn, pLenBuf); err != nil {
			return
		}
		pLen := int(pLenBuf[0])
		passwd := make([]byte, pLen)
		if _, err := io.ReadFull(conn, passwd); err != nil {
			return
		}

		if string(uName) != cfg.User || string(passwd) != cfg.Password {
			log.Printf("[AUTH] Failed auth for user %q from %s", string(uName), conn.RemoteAddr())
			conn.Write([]byte{0x01, 0x01}) // failure
			return
		}
		conn.Write([]byte{0x01, 0x00}) // success
		log.Printf("[AUTH] Authenticated user %q from %s", string(uName), conn.RemoteAddr())
	} else {
		// No auth required
		hasNone := false
		for _, m := range methods {
			if m == authNone {
				hasNone = true
				break
			}
		}
		if !hasNone {
			conn.Write([]byte{socks5Version, authNoAccept})
			return
		}
		conn.Write([]byte{socks5Version, authNone})
	}

	// --- Step 3: Client request ---
	// +----+-----+-------+------+----------+----------+
	// |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
	// +----+-----+-------+------+----------+----------+
	// | 1  |  1  | X'00' |  1   | Variable |    2     |
	// +----+-----+-------+------+----------+----------+
	reqHeader := make([]byte, 4)
	if _, err := io.ReadFull(conn, reqHeader); err != nil {
		log.Printf("[SOCKS5] Failed to read request: %v", err)
		return
	}
	if reqHeader[0] != socks5Version {
		return
	}
	if reqHeader[1] != cmdConnect {
		sendReply(conn, repCmdNotSupported, nil, 0)
		log.Printf("[SOCKS5] Unsupported command: %d", reqHeader[1])
		return
	}

	// Parse destination address
	var dest string
	switch reqHeader[3] {
	case addrIPv4:
		addr := make([]byte, 4)
		if _, err := io.ReadFull(conn, addr); err != nil {
			return
		}
		dest = net.IP(addr).String()
	case addrIPv6:
		addr := make([]byte, 16)
		if _, err := io.ReadFull(conn, addr); err != nil {
			return
		}
		dest = net.IP(addr).String()
	case addrDomain:
		lenBuf := make([]byte, 1)
		if _, err := io.ReadFull(conn, lenBuf); err != nil {
			return
		}
		domain := make([]byte, int(lenBuf[0]))
		if _, err := io.ReadFull(conn, domain); err != nil {
			return
		}
		dest = string(domain)
	default:
		sendReply(conn, repAddrNotSupported, nil, 0)
		return
	}

	portBuf := make([]byte, 2)
	if _, err := io.ReadFull(conn, portBuf); err != nil {
		return
	}
	port := binary.BigEndian.Uint16(portBuf)
	destAddr := fmt.Sprintf("%s:%d", dest, port)

	// --- Step 4: Dial destination ---
	conn.SetDeadline(time.Time{}) // clear deadline for long-lived tunnel

	log.Printf("[CONNECT] %s -> %s", conn.RemoteAddr(), destAddr)

	var destConn net.Conn
	var err error
	if tnet == nil {
		destConn, err = net.DialTimeout("tcp", destAddr, 10*time.Second)
	} else {
		destConn, err = tnet.Dial("tcp", destAddr)
	}
	if err != nil {
		log.Printf("[ERROR] Dial failed to %s: %v", destAddr, err)
		sendReply(conn, repHostUnreachable, nil, 0)
		return
	}
	defer destConn.Close()

	// --- Step 5: Send success reply ---
	// Use the local address of the outbound connection as BND.ADDR / BND.PORT
	localAddr := destConn.LocalAddr().(*net.TCPAddr)
	sendReply(conn, repSuccess, localAddr.IP, uint16(localAddr.Port))

	// --- Step 6: Pipe data bidirectionally ---
	go transfer(destConn, conn)
	transfer(conn, destConn)
}

// sendReply writes a SOCKS5 reply back to the client.
func sendReply(w io.Writer, rep byte, ip net.IP, port uint16) {
	// Use a zeroed IPv4 address if none provided
	if ip == nil || len(ip) == 0 {
		ip = net.IPv4zero.To4()
	}
	addr := ip.To4()
	atyp := addrIPv4
	if addr == nil {
		addr = ip.To16()
		atyp = addrIPv6
	}

	reply := make([]byte, 6+len(addr))
	reply[0] = socks5Version
	reply[1] = rep
	reply[2] = 0x00 // RSV
	reply[3] = atyp
	copy(reply[4:], addr)
	binary.BigEndian.PutUint16(reply[4+len(addr):], port)
	w.Write(reply)
}

func transfer(destination io.WriteCloser, source io.ReadCloser) {
	defer destination.Close()
	defer source.Close()
	io.Copy(destination, source)
}

func startWireGuard(cfg params) error {
	if cfg.WgPrivateKey == "" || cfg.WgPeerEndpoint == "" {
		log.Println("[INFO] WireGuard config missing, running in DIRECT mode (no VPN)")
		return nil
	}

	log.Println("[INFO] Initializing Userspace WireGuard...")

	localIPs := []netip.Addr{}
	if cfg.WgAddress != "" {
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
	log.Println("[STARTUP] Initializing SOCKS5 Proxy with Userspace WireGuard")

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

	addr := ":" + cfg.Port
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("[FATAL] Failed to listen on %s: %v", addr, err)
	}
	defer listener.Close()

	log.Printf("[READY] SOCKS5 proxy listening on %s", addr)

	for {
		clientConn, err := listener.Accept()
		if err != nil {
			log.Printf("[ERROR] Accept failed: %v", err)
			continue
		}
		go handleSocks5(clientConn, cfg)
	}
}

func base64ToHex(b64 string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(decoded), nil
}
