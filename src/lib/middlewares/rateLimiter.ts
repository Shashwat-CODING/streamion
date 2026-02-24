import { Context, Next } from "hono";

// 1 minute in milliseconds
const MIN_WINDOW_MS = 60 * 1000;
// 12 hours in milliseconds
const BLOCK_DURATION_MS = 12 * 60 * 60 * 1000;

// Maximum requests per minute
const MAX_REQUESTS = 10;

// Initialize KV for rate limiting state
const kv = await Deno.openKv();

export const rateLimiter = async (c: Context, next: Next) => {
    // Get client IP address
    const ip = c.req.header("cf-connecting-ip") || 
               c.req.header("x-forwarded-for") || 
               "unknown-ip";

    // Skip limiting if IP cannot be determined
    if (ip === "unknown-ip") {
        return await next();
    }

    const now = Date.now();
    const blockKey = ["rate_limit_block", ip];
    const reqKey = ["rate_limit_req", ip];

    // Check if IP is currently blocked
    const blockEntry = await kv.get<number>(blockKey);
    if (blockEntry.value && now < blockEntry.value) {
        c.header("Retry-After", Math.ceil((blockEntry.value - now) / 1000).toString());
        return c.text("Too Many Requests. IP blocked for 12 hours.", 429);
    } else if (blockEntry.value && now >= blockEntry.value) {
        // Remove block if expired
        await kv.delete(blockKey);
    }

    // Process current request
    const reqEntry = await kv.get<{ count: number, windowStart: number }>(reqKey);
    let count = 0;
    let windowStart = now;

    if (reqEntry.value) {
        if (now - reqEntry.value.windowStart < MIN_WINDOW_MS) {
            count = reqEntry.value.count;
            windowStart = reqEntry.value.windowStart;
        } else {
            // New time window
            count = 0;
            windowStart = now;
        }
    }

    count++;

    // Did the request exceed the limit?
    if (count > MAX_REQUESTS) {
        const blockUntil = now + BLOCK_DURATION_MS;
        await kv.set(blockKey, blockUntil, { expireIn: BLOCK_DURATION_MS });
        await kv.delete(reqKey);
        
        c.header("Retry-After", Math.ceil(BLOCK_DURATION_MS / 1000).toString());
        return c.text("Too Many Requests. IP blocked for 12 hours.", 429);
    }

    // Update count in KV
    await kv.set(reqKey, { count, windowStart }, { expireIn: MIN_WINDOW_MS });

    await next();
};
