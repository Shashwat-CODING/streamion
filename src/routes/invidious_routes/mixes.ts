import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Innertube } from "youtubei.js";

const mixes = new Hono();

interface VideoThumbnail {
    quality: string;
    url: string;
    width: number;
    height: number;
}

interface MixVideo {
    title: string;
    videoId: string;
    author: string;
    authorId: string;
    authorUrl: string;
    videoThumbnails: VideoThumbnail[];
    index: number;
    lengthSeconds: number;
}

interface MixResponse {
    title: string;
    mixId: string;
    videos: MixVideo[];
}

// Helper to generate video thumbnails
function generateVideoThumbnails(videoId: string): VideoThumbnail[] {
    const baseUrl = "https://i.ytimg.com";
    return [
        { quality: "maxres", url: `${baseUrl}/vi/${videoId}/maxresdefault.jpg`, width: 1280, height: 720 },
        { quality: "sddefault", url: `${baseUrl}/vi/${videoId}/sddefault.jpg`, width: 640, height: 480 },
        { quality: "high", url: `${baseUrl}/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
        { quality: "medium", url: `${baseUrl}/vi/${videoId}/mqdefault.jpg`, width: 320, height: 180 },
        { quality: "default", url: `${baseUrl}/vi/${videoId}/default.jpg`, width: 120, height: 90 },
    ];
}

// GET /:mixId - Get mix information
mixes.get("/:mixId", async (c) => {
    const mixId = c.req.param("mixId");
    const innertubeClient = c.get("innertubeClient") as Innertube;

    if (!mixId) {
        throw new HTTPException(400, { message: "Mix ID is required" });
    }

    console.log(`[INFO] Fetching mix: ${mixId}`);

    try {
        // Mixes are fetched like playlists
        const playlist = await innertubeClient.getPlaylist(mixId);
        const info = playlist.info as any;

        // Get videos
        const videos: MixVideo[] = [];
        let index = 0;
        for (const item of playlist.items) {
            const v = item as any;
            if (v.type === "PlaylistVideo" || v.id) {
                videos.push({
                    title: v.title?.text || "",
                    videoId: v.id || "",
                    author: v.author?.name || "",
                    authorId: v.author?.id || "",
                    authorUrl: v.author?.id ? `/channel/${v.author.id}` : "",
                    videoThumbnails: generateVideoThumbnails(v.id || ""),
                    index: index++,
                    lengthSeconds: v.duration?.seconds || 0
                });
            }
        }

        const response: MixResponse = {
            title: info?.title || "",
            mixId: mixId,
            videos: videos
        };

        return c.json(response);
    } catch (error) {
        console.error(`[ERROR] Failed to fetch mix ${mixId}:`, error);
        throw new HTTPException(500, { message: `Failed to fetch mix: ${error}` });
    }
});

export default mixes;
