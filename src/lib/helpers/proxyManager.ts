/**
 * Automatic Proxy Manager
 * Fetches free proxies from antpeak.com API and auto-rotates when they fail.
 * Tests proxies against YouTube to ensure they work for the application's needs.
 */

import { fetchUrbanProxy } from "./urbanProxy.ts";

// --- Configuration ---
const API_BASE = "https://antpeak.com";
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const APP_VERSION = "3.7.8";
const YOUTUBE_TEST_URL = "https://www.youtube.com/watch?v=bzbsJGMVHxQ";
const CUSTOM_PROXY_URL = "https://ytdlp-api-gbdn.onrender.com/proxies";

// --- Types ---
interface DeviceInfo {
    udid: string;
    appVersion: string;
    platform: string;
    platformVersion: string;
    timeZone: string;
    deviceName: string;
}

interface Location {
    id: string;
    region: string;
    name: string;
    countryCode: string;
    type: number;
    proxyType: number;
}

interface ProxyServer {
    addresses: string[];
    protocol: string;
    port: number;
    username?: string;
    password?: string;
}

// --- Singleton State ---
let currentProxyUrl: string | null = null;
let accessToken: string | null = null;
let freeLocations: Location[] = [];
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;
let vpnSource = 1;

// --- Helpers ---

async function fetchJson(
    endpoint: string,
    method: string,
    body?: unknown,
    token?: string,
): Promise<unknown> {
    const url = `${API_BASE}${endpoint}`;
    const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json",
    };

    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error ${response.status}: ${text}`);
    }

    return await response.json();
}

async function testProxyAgainstYouTube(proxyUrl: string): Promise<number | boolean> {
    try {
        const proxyUrlObj = new URL(proxyUrl);
        const clientOptions: Deno.CreateHttpClientOptions = {};

        if (proxyUrlObj.username && proxyUrlObj.password) {
            clientOptions.proxy = {
                url: `${proxyUrlObj.protocol}//${proxyUrlObj.host}`,
                basicAuth: {
                    username: decodeURIComponent(proxyUrlObj.username),
                    password: decodeURIComponent(proxyUrlObj.password),
                },
            };
        } else {
            clientOptions.proxy = {
                url: proxyUrl,
            };
        }

        const client = Deno.createHttpClient(clientOptions);

        const response = await fetch(YOUTUBE_TEST_URL, {
            client,
            signal: AbortSignal.timeout(15000), // 15 second timeout for test
            headers: {
                "User-Agent": USER_AGENT,
            },
        });

        client.close();

        // YouTube should return 200 or a redirect (3xx)
        if (response.ok || (response.status >= 300 && response.status < 400)) {
            return true;
        }
        return response.status;
    } catch (err) {
        // console.error("[ProxyManager] Proxy test failed:", err); // Verified by user request to just move to next
        return false;
    }
}

async function registerDevice(): Promise<string> {
    const deviceInfo: DeviceInfo = {
        udid: crypto.randomUUID(),
        appVersion: APP_VERSION,
        platform: "chrome",
        platformVersion: USER_AGENT,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        deviceName: "Chrome 120.0.0.0",
    };

    const launchResponse = await fetchJson(
        "/api/launch/",
        "POST",
        deviceInfo,
    ) as {
        success: boolean;
        data?: { accessToken: string };
    };

    if (!launchResponse.success || !launchResponse.data?.accessToken) {
        throw new Error("Failed to register device with antpeak.com");
    }

    return launchResponse.data.accessToken;
}

async function fetchLocations(token: string): Promise<Location[]> {
    const locationsResponse = await fetchJson(
        "/api/location/list/",
        "POST",
        undefined,
        token,
    ) as {
        success: boolean;
        data?: { locations: Location[] };
    };

    if (!locationsResponse.success || !locationsResponse.data?.locations) {
        throw new Error("Failed to fetch locations from antpeak.com");
    }

    // Filter for free locations (proxyType === 0)
    return locationsResponse.data.locations.filter((l) => l.proxyType === 0);
}

async function fetchProxyServer(
    token: string,
    location: Location,
): Promise<string | null> {
    const serverPayload = {
        protocol: "https",
        region: location.region,
        type: location.type,
    };

    const serverResponse = await fetchJson(
        "/api/server/list/",
        "POST",
        serverPayload,
        token,
    ) as {
        success: boolean;
        data?: ProxyServer[];
    };

    if (
        !serverResponse.success ||
        !Array.isArray(serverResponse.data) ||
        serverResponse.data.length === 0
    ) {
        return null;
    }

    const server = serverResponse.data[0];
    const ip = server.addresses[0];
    const port = server.port;
    const username = server.username || "";
    const password = server.password || "";

    if (!username) {
        return `https://${ip}:${port}`;
    } else {
        return `https://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${ip}:${port}`;
    }
}

// --- Public API ---

/**
 * Initialize the proxy manager. Fetches initial token and locations.
 * Safe to call multiple times - will only initialize once.
 */
export async function initProxyManager(source: number = 1): Promise<void> {
    vpnSource = source;
    if (isInitialized) return;

    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = (async () => {
        console.log("[ProxyManager] Initializing automatic proxy manager...");

        try {
            if (vpnSource === 1) {
                accessToken = await registerDevice();
                console.log("[ProxyManager] ✅ Registered with antpeak.com");

                freeLocations = await fetchLocations(accessToken);
                console.log(
                    `[ProxyManager] ✅ Found ${freeLocations.length} free locations`,
                );

                if (freeLocations.length === 0) {
                    throw new Error("No free proxy locations available");
                }
            } else if (vpnSource === 2) {
                console.log("[ProxyManager] Using Urban VPN source");
            } else if (vpnSource === 3) {
                console.log("[ProxyManager] Using Custom Proxy API source");
            }

            // Fetch initial proxy
            await rotateProxy();

            isInitialized = true;
            console.log("[ProxyManager] ✅ Initialization complete");
        } catch (err) {
            console.error("[ProxyManager] ❌ Initialization failed:", err);
            throw err;
        }
    })();

    return initializationPromise;
}

/**
 * Get the current proxy URL. Returns null if no proxy is available.
 */
export function getCurrentProxy(): string | null {
    return currentProxyUrl;
}

/**
 * Rotate to a new proxy. Tests against YouTube before accepting.
 * Will try multiple locations until a working proxy is found.
 */
export async function rotateProxy(): Promise<string | null> {
    console.log(`[ProxyManager] Rotation requested. Source: ${vpnSource}`);

    if (vpnSource === 2) {
        // Urban VPN Logic
        try {
            const urbanResult = await fetchUrbanProxy();
            if (urbanResult) {
                console.log(`[ProxyManager] Testing Urban proxy against YouTube...`);
                const result = await testProxyAgainstYouTube(urbanResult.url);
                if (result === true) {
                    currentProxyUrl = urbanResult.url;
                    console.log(`[ProxyManager] ✅ New Urban proxy active: ${urbanResult.host}`);
                    return currentProxyUrl;
                } else {
                    console.log(`[ProxyManager] ❌ Urban proxy failed YouTube test`);
                }
            }
        } catch (err) {
            console.error("[ProxyManager] Failed to fetch/test Urban proxy", err);
        }
        console.error("[ProxyManager] ❌ Could not find a working Urban proxy");
        currentProxyUrl = null;
        return null;
    }

    if (vpnSource === 3) {
        // Custom Proxy Logic
        console.log("[ProxyManager] Fetching proxies from custom API...");

        let attempts = 0;
        const maxAttempts = 10; // Increased retry limit as requested

        while (attempts < maxAttempts) {
            try {
                const response = await fetch(CUSTOM_PROXY_URL);
                if (!response.ok) {
                    throw new Error(`Failed to fetch proxies: ${response.statusText}`);
                }
                const data = await response.json() as { proxies: string[] };

                if (!data.proxies || !Array.isArray(data.proxies) || data.proxies.length === 0) {
                    console.log("[ProxyManager] No proxies returned from API, retrying...");
                    attempts++;
                    continue;
                }

                console.log(`[ProxyManager] Got ${data.proxies.length} proxies from API. Testing...`);

                for (const proxy of data.proxies) {
                    console.log(`[ProxyManager] Testing ${proxy}...`);
                    const result = await testProxyAgainstYouTube(proxy);

                    if (result === true) {
                        currentProxyUrl = proxy;
                        console.log(`[ProxyManager] ✅ New custom proxy active: ${proxy}`);
                        return currentProxyUrl;
                    } else if (typeof result === 'number') {
                        console.log(`[ProxyManager] ❌ Proxy returned status ${result}, trying next...`);
                    } else {
                        console.log(`[ProxyManager] ❌ Proxy unreachable, trying next...`);
                    }
                }

                console.log("[ProxyManager] All proxies from this batch failed. Refetching...");
                attempts++;

            } catch (err) {
                console.error("[ProxyManager] Error fetching custom proxies:", err);
                attempts++;
                // Wait a bit before retrying if it's a fetch error
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.error("[ProxyManager] ❌ Failed to find a working custom proxy after multiple attempts.");
        currentProxyUrl = null;
        return null;
    }

    if (!accessToken || freeLocations.length === 0) {
        console.error(
            "[ProxyManager] Not initialized or no locations available",
        );
        return null;
    }

    // Default AntPeak Logic (vpnSource === 1)
    if (!accessToken || freeLocations.length === 0) {
        console.error(
            "[ProxyManager] Not initialized or no locations available",
        );
        return null;
    }

    console.log("[ProxyManager] Rotating to new proxy (AntPeak)...");

    // Shuffle locations to get variety
    const shuffledLocations = [...freeLocations].sort(() =>
        Math.random() - 0.5
    );

    for (const location of shuffledLocations) {
        try {
            console.log(
                `[ProxyManager] Trying location: ${location.region} (${location.countryCode})`,
            );

            const proxyUrl = await fetchProxyServer(accessToken, location);
            if (!proxyUrl) {
                console.log(
                    `[ProxyManager] No server available for ${location.region}`,
                );
                continue;
            }

            // Test proxy against YouTube
            console.log(`[ProxyManager] Testing proxy against YouTube...`);
            const result = await testProxyAgainstYouTube(proxyUrl);

            if (result === true) {
                currentProxyUrl = proxyUrl;
                // Log without credentials for security
                const sanitizedUrl = proxyUrl.replace(
                    /:\/\/[^@]+@/,
                    "://***:***@",
                );
                console.log(
                    `[ProxyManager] ✅ New proxy active: ${sanitizedUrl}`,
                );
                return currentProxyUrl;
            } else {
                console.log(
                    `[ProxyManager] ❌ Proxy failed YouTube test, trying next...`,
                );
            }
        } catch (err) {
            console.error(
                `[ProxyManager] Error with location ${location.region}:`,
                err,
            );
        }
    }

    console.error("[ProxyManager] ❌ Could not find a working proxy");
    currentProxyUrl = null;
    return null;
}

/**
 * Mark the current proxy as failed and rotate to a new one.
 * Call this when a request fails due to proxy issues.
 */
export async function markProxyFailed(): Promise<string | null> {
    console.log("[ProxyManager] Current proxy marked as failed, rotating...");
    return await rotateProxy();
}

/**
 * Check if the proxy manager is initialized and has a working proxy.
 */
export function isProxyManagerReady(): boolean {
    return isInitialized && currentProxyUrl !== null;
}

/**
 * Re-register with the API (in case token expires).
 */
export async function refreshRegistration(): Promise<void> {
    console.log("[ProxyManager] Refreshing registration...");
    try {
        accessToken = await registerDevice();
        freeLocations = await fetchLocations(accessToken);
        console.log("[ProxyManager] ✅ Registration refreshed");
    } catch (err) {
        console.error("[ProxyManager] ❌ Failed to refresh registration:", err);
        throw err;
    }
}
