import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../../lib/helpers/youtubePlayerHandling.ts";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { encryptQuery } from "../../lib/helpers/encryptQuery.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";

const videos = new Hono();

interface Thumbnail {
    quality: string;
    url: string;
    width: number;
    height: number;
}

interface AuthorThumbnail {
    url: string;
    width: number;
    height: number;
}

interface Storyboard {
    url: string;
    templateUrl: string;
    width: number;
    height: number;
    count: number;
    interval: number;
    storyboardWidth: number;
    storyboardHeight: number;
    storyboardCount: number;
}

interface AdaptiveFormat {
    init?: string;
    index?: string;
    bitrate: string;
    url: string;
    itag: string;
    type: string;
    clen?: string;
    lmt?: string;
    projectionType: string;
    fps?: number;
    size?: string;
    resolution?: string;
    qualityLabel?: string;
    container?: string;
    encoding?: string;
    audioQuality?: string;
    audioSampleRate?: number;
    audioChannels?: number;
    colorInfo?: object;
}

interface FormatStream {
    url: string;
    itag: string;
    type: string;
    quality: string;
    bitrate: string;
    fps?: number;
    size?: string;
    resolution?: string;
    qualityLabel?: string;
    container?: string;
    encoding?: string;
}

interface Caption {
    label: string;
    language_code: string;
    url: string;
}

interface RecommendedVideo {
    videoId: string;
    title: string;
    videoThumbnails: Thumbnail[];
    author: string;
    authorUrl: string;
    authorId: string;
    authorVerified: boolean;
    lengthSeconds: number;
    viewCountText: string;
    published?: string;
    publishedText?: string;
}

// Generate thumbnail URLs for a video
function generateThumbnails(videoId: string, baseUrl: string): Thumbnail[] {
    return [
        { quality: "maxres", url: `${baseUrl}/vi/${videoId}/maxres.jpg`, width: 1280, height: 720 },
        { quality: "maxresdefault", url: `${baseUrl}/vi/${videoId}/maxresdefault.jpg`, width: 1280, height: 720 },
        { quality: "sddefault", url: `${baseUrl}/vi/${videoId}/sddefault.jpg`, width: 640, height: 480 },
        { quality: "high", url: `${baseUrl}/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
        { quality: "medium", url: `${baseUrl}/vi/${videoId}/mqdefault.jpg`, width: 320, height: 180 },
        { quality: "default", url: `${baseUrl}/vi/${videoId}/default.jpg`, width: 120, height: 90 },
        { quality: "start", url: `${baseUrl}/vi/${videoId}/1.jpg`, width: 120, height: 90 },
        { quality: "middle", url: `${baseUrl}/vi/${videoId}/2.jpg`, width: 120, height: 90 },
        { quality: "end", url: `${baseUrl}/vi/${videoId}/3.jpg`, width: 120, height: 90 },
    ];
}

// Parse storyboards from YouTube response
function parseStoryboards(storyboards: any, videoId: string): Storyboard[] {
    const result: Storyboard[] = [];
    if (!storyboards) return result;

    // Handle PlayerStoryboardSpec format
    if (storyboards.type === "PlayerStoryboardSpec" && storyboards.boards) {
        for (const board of storyboards.boards) {
            if (!board.template_url) continue;
            result.push({
                url: `/api/v1/storyboards/${videoId}?width=${board.thumbnail_width}&height=${board.thumbnail_height}`,
                templateUrl: board.template_url,
                width: board.thumbnail_width || 0,
                height: board.thumbnail_height || 0,
                count: board.thumbnail_count || 0,
                interval: board.interval || 0,
                storyboardWidth: board.columns || 0,
                storyboardHeight: board.rows || 0,
                storyboardCount: board.storyboard_count || 1,
            });
        }
    }

    return result;
}

// Convert YouTube format to Invidious adaptive format
function convertAdaptiveFormat(format: any): AdaptiveFormat {
    const result: AdaptiveFormat = {
        bitrate: String(format.bitrate || "0"),
        url: format.url || "",
        itag: String(format.itag || "0"),
        type: format.mime_type || "",
        projectionType: format.projection_type || "RECTANGULAR",
    };

    if (format.init_range) {
        result.init = `${format.init_range.start}-${format.init_range.end}`;
    }
    if (format.index_range) {
        result.index = `${format.index_range.start}-${format.index_range.end}`;
    }
    if (format.content_length) result.clen = String(format.content_length);
    if (format.last_modified) result.lmt = String(format.last_modified);
    if (format.fps) result.fps = format.fps;
    if (format.width && format.height) result.size = `${format.width}x${format.height}`;
    if (format.quality_label) {
        result.qualityLabel = format.quality_label;
        result.resolution = format.quality_label;
    }

    // Parse container and encoding from mime type
    const mimeMatch = format.mime_type?.match(/^(video|audio)\/(\w+)/);
    if (mimeMatch) {
        result.container = mimeMatch[2];
    }

    const codecMatch = format.mime_type?.match(/codecs="([^"]+)"/);
    if (codecMatch) {
        result.encoding = codecMatch[1].split(",")[0].trim();
    }

    if (format.audio_quality) result.audioQuality = format.audio_quality;
    if (format.audio_sample_rate) result.audioSampleRate = parseInt(format.audio_sample_rate);
    if (format.audio_channels) result.audioChannels = format.audio_channels;
    if (format.color_info) result.colorInfo = format.color_info;

    return result;
}

// Convert YouTube format to Invidious format stream (combined video+audio)
function convertFormatStream(format: any): FormatStream {
    const result: FormatStream = {
        url: format.url || "",
        itag: String(format.itag || "0"),
        type: format.mime_type || "",
        quality: format.quality || "medium",
        bitrate: String(format.bitrate || "0"),
    };

    if (format.fps) result.fps = format.fps;
    if (format.width && format.height) result.size = `${format.width}x${format.height}`;
    if (format.quality_label) {
        result.qualityLabel = format.quality_label;
        result.resolution = format.quality_label;
    }

    const mimeMatch = format.mime_type?.match(/^video\/(\w+)/);
    if (mimeMatch) {
        result.container = mimeMatch[1];
    }

    const codecMatch = format.mime_type?.match(/codecs="([^"]+)"/);
    if (codecMatch) {
        result.encoding = codecMatch[1].split(",")[0].trim();
    }

    return result;
}

// Convert description to HTML with links
function descriptionToHtml(description: string): string {
    if (!description) return "";

    // Escape HTML entities
    let html = description
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Convert URLs to links
    html = html.replace(
        /(https?:\/\/[^\s]+)/g,
        (url) => {
            const displayUrl = url.replace(/^https?:\/\//, "");
            return `<a href="${url}">${displayUrl}</a>`;
        }
    );

    // Convert hashtags to links
    html = html.replace(
        /#(\w+)/g,
        '<a href="/hashtag/$1">#$1</a>'
    );

    return html;
}

// Calculate relative time string
function getRelativeTimeString(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffYears > 0) return `${diffYears} year${diffYears > 1 ? "s" : ""} ago`;
    if (diffMonths > 0) return `${diffMonths} month${diffMonths > 1 ? "s" : ""} ago`;
    if (diffWeeks > 0) return `${diffWeeks} week${diffWeeks > 1 ? "s" : ""} ago`;
    if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    if (diffMinutes > 0) return `${diffMinutes} minute${diffMinutes > 1 ? "s" : ""} ago`;
    return "just now";
}

// Localize URL to route through local server
function localizeUrl(url: string, config: any): string {
    if (!url) return url;
    try {
        const urlParsed = new URL(url);
        let queryParams = new URLSearchParams(urlParsed.search);
        queryParams.set("host", urlParsed.host);

        if (config.server.encrypt_query_params) {
            const publicParams = [...queryParams].filter(([key]) =>
                ["pot", "ip"].includes(key) === false
            );
            const privateParams = [...queryParams].filter(([key]) =>
                ["pot", "ip"].includes(key) === true
            );
            const encryptedParams = encryptQuery(
                JSON.stringify(privateParams),
                config,
            );
            queryParams = new URLSearchParams(publicParams);
            queryParams.set("enc", "true");
            queryParams.set("data", encryptedParams);
        }

        return config.server.base_path + urlParsed.pathname + "?" + queryParams.toString();
    } catch {
        return url;
    }
}

videos.get("/:videoId", async (c) => {
    const videoId = c.req.param("videoId");
    const { local } = c.req.query();
    c.header("access-control-allow-origin", "*");
    c.header("content-type", "application/json");

    if (!videoId) {
        throw new HTTPException(400, {
            res: new Response(JSON.stringify({ error: "Video ID is required" })),
        });
    }

    if (!validateVideoId(videoId)) {
        throw new HTTPException(400, {
            res: new Response(JSON.stringify({ error: "Invalid video ID format" })),
        });
    }

    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    // Check if tokenMinter is ready (only needed when PO token is enabled)
    if (config.jobs.youtube_session.po_token_enabled && !tokenMinter) {
        throw new HTTPException(503, {
            res: new Response(JSON.stringify({ error: TOKEN_MINTER_NOT_READY_MESSAGE })),
        });
    }

    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        tokenMinter: tokenMinter!,
        metrics,
    }) as any;

    const videoInfo = youtubeVideoInfo(innertubeClient, youtubePlayerResponseJson);

    if (videoInfo.playability_status?.status !== "OK") {
        throw new HTTPException(400, {
            res: new Response(JSON.stringify({
                error: "Video unavailable",
                reason: videoInfo.playability_status?.reason,
            })),
        });
    }

    // Get the request origin for thumbnail URLs
    const origin = new URL(c.req.url).origin;
    const thumbnailBaseUrl = origin;

    // Build video details
    const details = videoInfo.basic_info;
    const streamingData = videoInfo.streaming_data;

    // Parse publish date
    let publishedTimestamp = 0;
    let publishedText = "";
    if (youtubePlayerResponseJson.microformat?.playerMicroformatRenderer?.publishDate) {
        const publishDate = new Date(youtubePlayerResponseJson.microformat.playerMicroformatRenderer.publishDate);
        publishedTimestamp = Math.floor(publishDate.getTime() / 1000);
        publishedText = getRelativeTimeString(publishDate);
    }

    // Build adaptive formats
    const adaptiveFormats: AdaptiveFormat[] = [];
    if (streamingData?.adaptive_formats) {
        for (const format of streamingData.adaptive_formats) {
            const converted = convertAdaptiveFormat(format);
            if (local) {
                converted.url = localizeUrl(converted.url, config);
            }
            adaptiveFormats.push(converted);
        }
    }

    // Build format streams (combined video+audio)
    const formatStreams: FormatStream[] = [];
    if (streamingData?.formats) {
        for (const format of streamingData.formats) {
            const converted = convertFormatStream(format);
            if (local) {
                converted.url = localizeUrl(converted.url, config);
            }
            formatStreams.push(converted);
        }
    }

    // Build captions
    const captions: Caption[] = [];
    if (videoInfo.captions?.caption_tracks) {
        for (const track of videoInfo.captions.caption_tracks) {
            captions.push({
                label: track.name?.text || track.language_code || "Unknown",
                language_code: track.language_code || "en",
                url: `/api/v1/captions/${videoId}?label=${encodeURIComponent(track.name?.text || track.language_code || "")}`,
            });
        }
    }

    // Build recommended videos
    const recommendedVideos: RecommendedVideo[] = [];
    // Note: Related videos require a separate API call to /next endpoint
    // For now, we return an empty array - this can be enhanced later

    // Build author thumbnails from raw YouTube response
    const authorThumbnails: AuthorThumbnail[] = [];
    const channelThumbnails = youtubePlayerResponseJson.videoDetails?.author?.thumbnail?.thumbnails ||
        youtubePlayerResponseJson.microformat?.playerMicroformatRenderer?.ownerProfileUrl ? [] : [];

    // Generate standard author thumbnail sizes if we have the channel ID
    if (details.channel_id) {
        const sizes = [32, 48, 76, 100, 176, 512];
        for (const size of sizes) {
            authorThumbnails.push({
                url: `https://yt3.ggpht.com/a/default-user=s${size}-c-k-c0x00ffffff-no-rj`,
                width: size,
                height: size,
            });
        }
    }

    // Get allowed regions
    const allowedRegions = youtubePlayerResponseJson.microformat?.playerMicroformatRenderer?.availableCountries || [];

    const response = {
        type: "video",
        title: details.title || "",
        videoId: videoId,
        videoThumbnails: generateThumbnails(videoId, thumbnailBaseUrl),
        storyboards: parseStoryboards(videoInfo.storyboards, videoId),
        description: details.short_description || "",
        descriptionHtml: descriptionToHtml(details.short_description || ""),
        published: publishedTimestamp,
        publishedText: publishedText,
        keywords: details.keywords || [],
        viewCount: details.view_count || 0,
        likeCount: details.like_count || 0,
        dislikeCount: 0, // YouTube no longer provides dislike count
        paid: false,
        premium: false,
        isFamilyFriendly: youtubePlayerResponseJson.microformat?.playerMicroformatRenderer?.isFamilySafe ?? true,
        allowedRegions: allowedRegions,
        genre: youtubePlayerResponseJson.microformat?.playerMicroformatRenderer?.category || "Unknown",
        genreUrl: null,
        author: details.author || "",
        authorId: details.channel_id || "",
        authorUrl: `/channel/${details.channel_id || ""}`,
        authorVerified: false, // Would need additional API call to check
        authorThumbnails: authorThumbnails,
        subCountText: "", // Would need additional API call
        lengthSeconds: details.duration || 0,
        allowRatings: details.allow_ratings ?? true,
        rating: 0,
        isListed: !details.is_unlisted,
        liveNow: details.is_live || false,
        isPostLiveDvr: details.is_post_live_dvr || false,
        isUpcoming: details.is_upcoming || false,
        dashUrl: `${origin}/api/manifest/dash/id/${videoId}`,
        adaptiveFormats: adaptiveFormats,
        formatStreams: formatStreams,
        captions: captions,
        recommendedVideos: recommendedVideos,
    };

    return c.json(response);
});

export default videos;
