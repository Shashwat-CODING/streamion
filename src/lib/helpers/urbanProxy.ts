const ACCOUNT_API = "https://api-pro.urban-vpn.com/rest/v1";
const STATS_API = "https://stats.urban-vpn.com/api/rest/v2";
const CLIENT_APP = "URBAN_VPN_BROWSER_EXTENSION";
const BROWSER = "CHROME";

interface UrbanProxyResult {
    url: string;
    protocol: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
}

const PREFERRED_COUNTRIES = ["US", "GB", "CA", "DE", "FR", "NL", "ES", "IT", "JP", "KR", "SG", "AU"];

export async function fetchUrbanProxy(targetCountryCode = "RANDOM"): Promise<UrbanProxyResult | null> {
    console.log(`[UrbanVPN] Fetching Urban VPN Proxy (Target: ${targetCountryCode})...`);

    // 1. Register Anonymous
    // console.log("[UrbanVPN] 1. Registering Anonymous User...");
    const regUrl = `${ACCOUNT_API}/registrations/clientApps/${CLIENT_APP}/users/anonymous`;

    const regHeaders = {
        "content-type": "application/json",
        "accept": "application/json, text/plain, */*",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
    };

    const regPayload = {
        clientApp: {
            name: CLIENT_APP,
            browser: BROWSER
        }
    };

    let regResp;
    try {
        regResp = await fetch(regUrl, {
            method: "POST",
            headers: regHeaders,
            body: JSON.stringify(regPayload)
        });
    } catch (err) {
        console.error("[UrbanVPN] Network error during registration:", err);
        return null;
    }

    if (!regResp.ok) {
        const text = await regResp.text();
        console.error(`[UrbanVPN] Registration failed: ${regResp.status} ${regResp.statusText}`);
        console.error(text);
        return null;
    }

    const regData = await regResp.json();
    const idToken = regData.id_token || regData.idToken || regData.value;

    if (!idToken) {
        console.error("[UrbanVPN] No ID token found in registration response.");
        return null;
    }

    // 2. Get Security Token
    // console.log("[UrbanVPN] 2. Getting Security Token...");
    const secUrl = `${ACCOUNT_API}/security/tokens/accs`;
    const secHeaders = {
        ...regHeaders,
        "authorization": `Bearer ${idToken}`
    };
    const secPayload = {
        type: "accs",
        clientApp: {
            name: CLIENT_APP
        }
    };

    const secResp = await fetch(secUrl, {
        method: "POST",
        headers: secHeaders,
        body: JSON.stringify(secPayload)
    });

    if (!secResp.ok) {
        const text = await secResp.text();
        console.error(`[UrbanVPN] Security Token request failed: ${secResp.status}`);
        console.error(text);
        return null;
    }

    const secData = await secResp.json();

    let tokenString = "";
    let credUsername = "";
    const credPassword = "1";

    if (secData.token && typeof secData.token === 'object' && secData.token.value) {
        tokenString = secData.token.value;
        credUsername = secData.token.value;
    } else if (typeof secData.token === 'string') {
        tokenString = secData.token;
        credUsername = secData.token;

    } else if (secData.value) {
        tokenString = secData.value;
        credUsername = secData.value;
    }

    if (!tokenString) {
        console.error("[UrbanVPN] No security token found.");
        return null;
    }

    // 3. Get Countries / Proxies
    // console.log("[UrbanVPN] 3. Fetching Proxy List...");
    const countriesUrl = `${STATS_API}/entrypoints/countries`;
    const proxyHeaders = {
        ...regHeaders,
        "authorization": `Bearer ${tokenString}`,
        "X-Client-App": CLIENT_APP
    };

    // @ts-ignore: delete operator on string index signature
    delete proxyHeaders["content-type"];

    const countriesResp = await fetch(countriesUrl, {
        headers: proxyHeaders
    });

    if (!countriesResp.ok) {
        const text = await countriesResp.text();
        console.error(`[UrbanVPN] Failed to fetch countries: ${countriesResp.status}`);
        console.error(text);
        return null;
    }

    const countriesData = await countriesResp.json();

    if (!countriesData.countries || !countriesData.countries.elements) {
        console.error("[UrbanVPN] Invalid countries data format.");
        return null;
    }

    const countries = countriesData.countries.elements;

    // Pick a country
    let selectedCountryCode = targetCountryCode;
    if (selectedCountryCode === "RANDOM") {
        selectedCountryCode = PREFERRED_COUNTRIES[Math.floor(Math.random() * PREFERRED_COUNTRIES.length)];
    }

    // Find target country proxy
    // deno-lint-ignore no-explicit-any
    let targetCountry = countries.find((c: any) => c.code.iso2 === selectedCountryCode);

    // Fallback if random choice not found
    if (!targetCountry) {
        targetCountry = countries[0];
        console.log(`[UrbanVPN] Requested country ${selectedCountryCode} not found, falling back to ${targetCountry.code.iso2}`);
    }

    if (targetCountry) {
        console.log(`[UrbanVPN] Selected Country: ${targetCountry.title} (${targetCountry.code.iso2})`);

        let proxyHost = null;
        let proxyPort = null;
        let signature = null;

        if (targetCountry.address && targetCountry.address.primary) {
            proxyHost = targetCountry.address.primary.host;
            proxyPort = targetCountry.address.primary.port;
        }
        else if (targetCountry.servers && targetCountry.servers.elements && targetCountry.servers.elements.length > 0) {
            // Pick a RANDOM server from the list
            const serverIndex = Math.floor(Math.random() * targetCountry.servers.elements.length);
            const srv = targetCountry.servers.elements[serverIndex];

            if (srv.address && srv.address.primary) {
                proxyHost = srv.address.primary.host;
                proxyPort = srv.address.primary.port || srv.address.primary.port_min;
                signature = srv.signature;
            }
        }

        if (signature) {
            // console.log("[UrbanVPN] Found proxy signature, fetching Auth Proxy Token...");
            const proxyTokenUrl = `${ACCOUNT_API}/security/tokens/accs-proxy`;
            const proxyTokenPayload = {
                type: "accs-proxy",
                clientApp: { name: CLIENT_APP },
                signature: signature
            };

            const proxyTokenHeaders = {
                ...regHeaders,
                "authorization": `Bearer ${tokenString}`
            };

            const ptResp = await fetch(proxyTokenUrl, {
                method: "POST",
                headers: proxyTokenHeaders,
                body: JSON.stringify(proxyTokenPayload)
            });

            if (ptResp.ok) {
                const ptData = await ptResp.json();
                if (ptData.value) {
                    credUsername = ptData.value;
                } else if (ptData.token && ptData.token.value) {
                    credUsername = ptData.token.value;
                }
            } else {
                console.error(`[UrbanVPN] Failed to get Proxy Auth Token: ${ptResp.status}`);
            }
        }

        if (proxyHost) {
            const proxyUrl = `http://${encodeURIComponent(credUsername)}:${encodeURIComponent(credPassword)}@${proxyHost}:${proxyPort}`;
            console.log(`[UrbanVPN] Proxy found: ${proxyHost}:${proxyPort}`);
            return {
                url: proxyUrl,
                protocol: 'http',
                host: proxyHost,
                port: proxyPort,
                username: credUsername,
                password: credPassword
            };
        }
    }

    console.error("[UrbanVPN] No proxy server details found.");
    return null;
}
