import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Innertube } from "youtubei.js";

const search = new Hono();

// Helper to convert duration string to seconds (e.g., "12:34" -> 754)
function parseDuration(durationVal: string | number | undefined): number {
    if (typeof durationVal === 'number') return durationVal;
    if (!durationVal) return 0;

    // Check if it's just seconds as a string
    if (!durationVal.includes(':')) {
        return parseInt(durationVal, 10) || 0;
    }

    const parts = durationVal.split(':').map(Number);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return 0;
}

// Helper to parse relative time to seconds (approximate)
function parseRelativeTime(text: string | undefined): number {
    if (!text) return 0;
    const now = Date.now();
    // This is a very rough approximation as we don't have the exact date
    // You might want to use a library or more complex logic here if needed
    // For now, we'll just return date.now / 1000 to be safe or 0
    // A better approach would be to parse "2 years ago" etc. 
    // But Invidious often returns the timestamp of the upload.
    // If not available, 0 is often used as a fallback.
    return Math.floor(now / 1000);
}


search.get("/", async (c) => {
    const q = c.req.query("q");
    const page = parseInt(c.req.query("page") || "1");
    const type = c.req.query("type") || "all";

    c.header("access-control-allow-origin", "*");
    c.header("content-type", "application/json");

    if (!q) {
        throw new HTTPException(400, {
            res: new Response(JSON.stringify({ error: "Query parameter 'q' is required" })),
        });
    }

    const innertubeClient = c.get("innertubeClient") as Innertube;

    try {
        // Map 'type' to YouTubei filters
        let filters: any = {};
        if (type === "video") filters.type = "video";
        else if (type === "channel") filters.type = "channel";
        else if (type === "playlist") filters.type = "playlist";
        // 'all' uses default, no filter needed usually, or we can fetch without filters

        const searchResults = await innertubeClient.search(q, filters);

        // Note: Pagination support in InnerTube search is via 'getContinuation', 
        // but existing stateless endpoints often just fetch the first batch. 
        // Fully implementing page 2+ requires handling continuation tokens, 
        // usually passed back to the client. The 'page' param in Invidious 
        // is often abstraction. For now, we return the initial results. 
        // If the user needs deep pagination, we'd need to store/pass continuation tokens.

        const items = searchResults.results || [];

        // Mapped results
        const response: any[] = [];

        for (const item of items) {
            if (item.type === "Video" || item.type === "CompactVideo") {
                const video = item as any; // Cast to any to access properties safely
                response.push({
                    type: "video",
                    title: video.title?.text || "",
                    videoId: video.id,
                    author: video.author?.name || "",
                    authorId: video.author?.id || "",
                    authorUrl: video.author?.url || (video.author?.id ? `/channel/${video.author?.id}` : ""),
                    authorVerified: video.author?.is_verified || false,
                    authorThumbnails: video.author?.thumbnails || [],
                    videoThumbnails: video.thumbnails || [],
                    description: video.description?.text || "",
                    descriptionHtml: video.description?.text || "", // Basic text for now
                    viewCount: video.view_count?.text ? parseInt(video.view_count.text.replace(/[^0-9]/g, '')) : 0,
                    viewCountText: video.view_count?.text || "0 views",
                    published: parseRelativeTime(video.published?.text),
                    publishedText: video.published?.text || "",
                    lengthSeconds: parseDuration(video.duration?.text),
                    liveNow: video.is_live || false,
                    premium: false, // Not easily available
                    isUpcoming: video.upcoming || false,
                    isNew: false, // Logic needed
                    is4k: false, // Check badges?
                    is8k: false,
                    isVr180: false,
                    isVr360: false,
                    is3d: false,
                    hasCaptions: false // Check badges?
                });
            } else if (item.type === "Channel") {
                const channel = item as any;
                response.push({
                    type: "channel",
                    author: channel.author?.name || channel.title?.text || "",
                    authorId: channel.id,
                    authorUrl: `/channel/${channel.id}`,
                    authorVerified: channel.author?.is_verified || false,
                    authorThumbnails: channel.thumbnails || [],
                    autoGenerated: false,
                    subCount: channel.subscriber_count?.text ? parseInt(channel.subscriber_count.text.replace(/[^0-9]/g, '')) : 0,
                    videoCount: 0, // Often not in search snippets
                    channelHandle: "", // Might be in url
                    description: channel.description_snippet?.text || "",
                    descriptionHtml: channel.description_snippet?.text || ""
                });
            } else if (item.type === "Playlist") {
                const playlist = item as any;
                response.push({
                    type: "playlist",
                    title: playlist.title?.text || "",
                    playlistId: playlist.id,
                    playlistThumbnail: playlist.thumbnails?.[0]?.url || "",
                    author: playlist.author?.name || "",
                    authorId: playlist.author?.id || "",
                    authorUrl: `/channel/${playlist.author?.id || ""}`,
                    authorVerified: playlist.author?.is_verified || false,
                    videoCount: parseInt(playlist.video_count?.replace(/[^0-9]/g, '') || "0"),
                    videos: [] // Search result usually doesn't have video list inside
                });
            } else if (item.type === "LockupView") {
                const lockup = item as any;
                const contentId = lockup.content_id;

                if (contentId?.startsWith("PL")) {
                    // Playlist
                    let author = "";
                    let authorId = "";
                    let authorUrl = "";
                    let videoCount = 0;
                    let thumbnail = "";

                    // Extract thumbnail
                    const primaryThumbnail = lockup.content_image?.primary_thumbnail;
                    if (primaryThumbnail?.image && primaryThumbnail.image.length > 0) {
                        thumbnail = primaryThumbnail.image[0].url;
                    }

                    // Extract video count from overlays
                    if (primaryThumbnail?.overlays) {
                        for (const overlay of primaryThumbnail.overlays) {
                            if (overlay.badges) {
                                for (const badge of overlay.badges) {
                                    if (badge.text && badge.text.includes("videos")) {
                                        const match = badge.text.match(/([\d,]+)\s+videos/);
                                        if (match) {
                                            videoCount = parseInt(match[1].replace(/,/g, ""));
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Extract author, authorId, and authorUrl from metadata rows
                    if (lockup.metadata?.metadata?.metadata_rows) {
                        for (const row of lockup.metadata.metadata.metadata_rows) {
                            if (row.metadata_parts) {
                                for (const part of row.metadata_parts) {
                                    if (part.text?.runs) {
                                        for (const run of part.text.runs) {
                                            if (run.endpoint?.metadata?.page_type === "WEB_PAGE_TYPE_CHANNEL") {
                                                author = run.text;
                                                authorId = run.endpoint?.payload?.browseId || "";
                                                authorUrl = run.endpoint?.payload?.canonicalBaseUrl || (authorId ? `/channel/${authorId}` : "");
                                                break;
                                            }
                                        }
                                    }
                                    if (author) break;
                                }
                            }
                            if (author) break;
                        }
                    }

                    // Fallback for author
                    if (!author && lockup.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text?.text) {
                        author = lockup.metadata.metadata.metadata_rows[0].metadata_parts[0].text.text;
                    }

                    response.push({
                        type: "playlist",
                        title: lockup.metadata?.title?.text || "Unknown Playlist",
                        playlistId: contentId,
                        playlistThumbnail: thumbnail,
                        author: author,
                        authorId: authorId,
                        authorUrl: authorUrl,
                        authorVerified: false,
                        videoCount: videoCount,
                        videos: []
                    });
                } else if (contentId?.startsWith("UC")) {
                    // Channel
                    response.push({
                        type: "channel",
                        author: lockup.metadata?.title?.text || "Unknown Channel",
                        authorId: contentId,
                        authorUrl: `/channel/${contentId}`,
                        authorVerified: false,
                        authorThumbnails: lockup.content_image?.primary_thumbnail?.thumbnails || [],
                        autoGenerated: false,
                        subCount: 0,
                        videoCount: 0,
                        channelHandle: "",
                        description: "",
                        descriptionHtml: ""
                    });
                } else {
                    // Assume Video
                    response.push({
                        type: "video",
                        title: lockup.metadata?.title?.text || "Unknown Video",
                        videoId: contentId,
                        author: "", // Parsing from metadata lines is complex
                        authorId: "",
                        authorUrl: "",
                        authorVerified: false,
                        authorThumbnails: [], // Often missing in LockupView
                        videoThumbnails: lockup.content_image?.primary_thumbnail?.thumbnails || [],
                        description: "",
                        descriptionHtml: "",
                        viewCount: 0,
                        viewCountText: "",
                        published: 0,
                        publishedText: "",
                        lengthSeconds: 0, // Duration might be in metadata
                        liveNow: false,
                        premium: false,
                        isUpcoming: false,
                        isNew: false,
                        is4k: false,
                        is8k: false,
                        isVr180: false,
                        isVr360: false,
                        is3d: false,
                        hasCaptions: false
                    });
                }
            }
        }

        return c.json(response);

    } catch (error) {
        console.error("[ERROR] Failed to fetch search results:", error);
        throw new HTTPException(500, {
            res: new Response(JSON.stringify({ error: "Failed to fetch search results" })),
        });
    }
});

search.get("/suggestions", async (c) => {
    const q = c.req.query("q");
    c.header("access-control-allow-origin", "*");
    c.header("content-type", "application/json");

    if (!q) {
        throw new HTTPException(400, {
            res: new Response(JSON.stringify({ error: "Query parameter 'q' is required" })),
        });
    }

    const innertubeClient = c.get("innertubeClient") as Innertube;

    try {
        const suggestions = await innertubeClient.getSearchSuggestions(q);
        return c.json({
            query: q,
            suggestions: suggestions,
        });
    } catch (error) {
        console.error("[ERROR] Failed to fetch search suggestions:", error);
        throw new HTTPException(500, {
            res: new Response(JSON.stringify({ error: "Failed to fetch search suggestions" })),
        });
    }
});

export default search;
