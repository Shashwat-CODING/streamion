import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";
import { getCurrentProxy } from "./proxyManager.ts";

type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
    | RequestInit
    | RequestInit & { client: Deno.HttpClient };
type FetchReturn = ReturnType<typeof fetch>;

export const getFetchClient = (config: Config): {
    (
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
    ): FetchReturn;
} => {
    return async (
        input: FetchInputParameter,
        init?: RequestInit,
    ) => {
        // Use auto-fetched proxy if enabled, otherwise use configured proxy
        const proxyAddress = config.networking.auto_proxy
            ? getCurrentProxy()
            : config.networking.proxy;
        const ipv6Block = config.networking.ipv6_block;

        // If proxy or IPv6 rotation is configured, create a custom HTTP client
        if (proxyAddress || ipv6Block) {
            const clientOptions: Deno.CreateHttpClientOptions = {};

            if (proxyAddress) {
                try {
                    const proxyUrl = new URL(proxyAddress);
                    // Extract credentials if present
                    if (proxyUrl.username && proxyUrl.password) {
                        clientOptions.proxy = {
                            url: `${proxyUrl.protocol}//${proxyUrl.host}`,
                            basicAuth: {
                                username: decodeURIComponent(proxyUrl.username),
                                password: decodeURIComponent(proxyUrl.password),
                            },
                        };
                    } else {
                        clientOptions.proxy = {
                            url: proxyAddress,
                        };
                    }
                } catch {
                    clientOptions.proxy = {
                        url: proxyAddress,
                    };
                }
            }

            if (ipv6Block) {
                clientOptions.localAddress = generateRandomIPv6(ipv6Block);
            }

            const client = Deno.createHttpClient(clientOptions);
            const fetchRes = await fetchShim(config, input, {
                client,
                headers: init?.headers,
                method: init?.method,
                body: init?.body,
            });
            client.close(); // Important: close client to avoid leaking resources
            return new Response(fetchRes.body, {
                status: fetchRes.status,
                headers: fetchRes.headers,
            });
        }

        return fetchShim(config, input, init);
    };
};

function fetchShim(
    config: Config,
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
): FetchReturn {
    const fetchTimeout = config.networking.fetch?.timeout_ms;
    const fetchRetry = config.networking.fetch?.retry?.enabled;
    const fetchMaxAttempts = config.networking.fetch?.retry?.times;
    const fetchInitialDebounce = config.networking.fetch?.retry
        ?.initial_debounce;
    const fetchDebounceMultiplier = config.networking.fetch?.retry
        ?.debounce_multiplier;
    const retryOptions: RetryOptions = {
        maxAttempts: fetchMaxAttempts,
        minTimeout: fetchInitialDebounce,
        multiplier: fetchDebounceMultiplier,
        jitter: 0,
    };

    const callFetch = () =>
        fetch(input, {
            // only set the AbortSignal if the timeout is supplied in the config
            signal: fetchTimeout
                ? AbortSignal.timeout(Number(fetchTimeout))
                : null,
            ...(init || {}),
        });
    // if retry enabled, call retry with the fetch shim, otherwise pass the fetch shim back directly
    return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}
