import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Innertube } from "youtubei.js";

const playlists = new Hono();

interface Thumbnail {
    url: string;
    width: number;
    height: number;
}

interface VideoThumbnail {
    quality: string;
    url: string;
    width: number;
    height: number;
}

interface PlaylistVideo {
    type: string;
    title: string;
    videoId: string;
    author: string;
    authorId: string;
    authorUrl: string;
    videoThumbnails: VideoThumbnail[];
    index: number;
    lengthSeconds: number;
    liveNow: boolean;
}

interface PlaylistResponse {
    type: string;
    title: string;
    playlistId: string;
    playlistThumbnail: string;
    author: string;
    authorId: string;
    authorUrl: string;
    subtitle: object | null;
    authorThumbnails: Thumbnail[];
    description: string;
    descriptionHtml: string;
    videoCount: number;
    viewCount: number;
    updated: number;
    isListed: boolean;
    videos: PlaylistVideo[];
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

// Helper to parse view count
function parseViewCount(text: string | undefined): number {
    if (!text) return 0;
    const match = text.match(/([\d,]+)/);
    if (match) {
        return parseInt(match[1].replace(/,/g, "")) || 0;
    }
    return 0;
}

// GET /:playlistId - Get playlist information
playlists.get("/:playlistId", async (c) => {
    const playlistId = c.req.param("playlistId");
    const innertubeClient = c.get("innertubeClient") as Innertube;

    if (!playlistId) {
        throw new HTTPException(400, { message: "Playlist ID is required" });
    }

    console.log(`[INFO] Fetching playlist: ${playlistId}`);

    try {
        const playlist = await innertubeClient.getPlaylist(playlistId);
        const info = playlist.info as any;

        // Extract author info
        let author = "";
        let authorId = "";
        let authorUrl = "";
        const authorThumbnails: Thumbnail[] = [];

        if (info?.author) {
            author = info.author.name || "";
            authorId = info.author.id || "";
            authorUrl = authorId ? `/channel/${authorId}` : "";
        }

        // Get author thumbnails
        if (info?.author?.thumbnails && Array.isArray(info.author.thumbnails)) {
            for (const thumb of info.author.thumbnails) {
                authorThumbnails.push({
                    url: thumb.url,
                    width: thumb.width || 0,
                    height: thumb.height || 0
                });
            }
        }

        // Get playlist thumbnail
        let playlistThumbnail = "";
        if (info?.thumbnails && info.thumbnails.length > 0) {
            playlistThumbnail = info.thumbnails[0].url || "";
        }

        // Get videos
        const videos: PlaylistVideo[] = [];
        let index = 0;
        for (const item of playlist.items) {
            const v = item as any;
            if (v.type === "PlaylistVideo" || v.id) {
                videos.push({
                    type: "video",
                    title: v.title?.text || "",
                    videoId: v.id || "",
                    author: v.author?.name || author,
                    authorId: v.author?.id || authorId,
                    authorUrl: v.author?.id ? `/channel/${v.author.id}` : authorUrl,
                    videoThumbnails: generateVideoThumbnails(v.id || ""),
                    index: index++,
                    lengthSeconds: v.duration?.seconds || 0,
                    liveNow: v.is_live || false
                });
            }
        }

        const response: PlaylistResponse = {
            type: "playlist",
            title: info?.title || "",
            playlistId: playlistId,
            playlistThumbnail: playlistThumbnail,
            author: author,
            authorId: authorId,
            authorUrl: authorUrl,
            subtitle: null,
            authorThumbnails: authorThumbnails,
            description: info?.description || "",
            descriptionHtml: info?.description || "",
            videoCount: parseViewCount(String(info?.total_items || "")) || videos.length,
            viewCount: parseViewCount(info?.views?.text),
            updated: 0, // Not easily available
            isListed: true,
            videos: videos
        };

        return c.json(response);
    } catch (error) {
        console.error(`[ERROR] Failed to fetch playlist ${playlistId}:`, error);
        throw new HTTPException(500, { message: `Failed to fetch playlist: ${error}` });
    }
});

export default playlists;
