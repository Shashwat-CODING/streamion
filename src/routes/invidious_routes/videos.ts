import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../../lib/helpers/youtubePlayerHandling.ts";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { encryptQuery } from "../../lib/helpers/encryptQuery.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";
import { YT, YTNodes } from "youtubei.js";

const videos = new Hono();

// ─── Interfaces ──────────────────────────────────────────────────────────────

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
    init: string;
    index: string;
    bitrate: string;
    url: string;
    itag: string;
    type: string;
    clen: string;
    lmt: string;
    projectionType: string;
    container: string;
    encoding: string;
    audioQuality: string;
    audioSampleRate: number;
    audioChannels: number;
    resolution: string;
    qualityLabel: string;
    quality: string;
}

interface FormatStream {
    url: string;
    itag: string;
    type: string;
    quality: string;
    bitrate: string;
    fps: number;
    size: string;
    resolution: string;
    qualityLabel: string;
    container: string;
    encoding: string;
    clen?: string;
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
    published: string;
    publishedText: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateThumbnails(videoId: string): Thumbnail[] {
    const base = "https://i.ytimg.com";
    return [
        { quality: "maxres", url: `${base}/vi/${videoId}/maxresdefault.jpg`, width: 1280, height: 720 },
        { quality: "maxresdefault", url: `${base}/vi/${videoId}/maxresdefault.jpg`, width: 1280, height: 720 },
        { quality: "sddefault", url: `${base}/vi/${videoId}/sddefault.jpg`, width: 640, height: 480 },
        { quality: "high", url: `${base}/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
        { quality: "medium", url: `${base}/vi/${videoId}/mqdefault.jpg`, width: 320, height: 180 },
        { quality: "default", url: `${base}/vi/${videoId}/default.jpg`, width: 120, height: 90 },
        { quality: "start", url: `${base}/vi/${videoId}/1.jpg`, width: 120, height: 90 },
        { quality: "middle", url: `${base}/vi/${videoId}/2.jpg`, width: 120, height: 90 },
        { quality: "end", url: `${base}/vi/${videoId}/3.jpg`, width: 120, height: 90 },
    ];
}

function parseStoryboards(storyboardsRaw: any, videoId: string): Storyboard[] {
    const result: Storyboard[] = [];
    if (!storyboardsRaw?.playerStoryboardSpecRenderer?.spec) return result;

    const spec = storyboardsRaw.playerStoryboardSpecRenderer.spec as string;
    const specParts = spec.split("|");
    const baseUrl = specParts[0];

    for (let i = 3; i < specParts.length; i++) {
        const parts = specParts[i].split("#");
        if (parts.length < 8) continue;
        const [width, height, count, columns, rows, interval, name, sigh] = parts;
        const storyboardCount = Math.ceil(
            parseInt(count) / (parseInt(columns) * parseInt(rows)),
        );

        let templateUrl = baseUrl
            .replace("$L", String(i - 3))
            .replace("$N", name) + "$M";
        if (sigh) templateUrl += "&sigh=" + sigh;

        result.push({
            url: `/api/v1/storyboards/${videoId}?width=${width}&height=${height}`,
            templateUrl,
            width: parseInt(width),
            height: parseInt(height),
            count: parseInt(count),
            interval: parseInt(interval),
            storyboardWidth: parseInt(columns),
            storyboardHeight: parseInt(rows),
            storyboardCount,
        });
    }

    return result;
}

function mimeToContainerEncoding(mimeType: string): { container: string; encoding: string } {
    const containerMatch = mimeType?.match(/^(?:video|audio)\/(\w+)/);
    const encodingMatch = mimeType?.match(/codecs="([^"]+)"/);
    return {
        container: containerMatch ? containerMatch[1] : "",
        encoding: encodingMatch ? encodingMatch[1].split(",")[0].trim() : "",
    };
}

function convertAdaptiveFormat(format: any): AdaptiveFormat {
    const { container, encoding } = mimeToContainerEncoding(format.mimeType);
    return {
        init: format.initRange ? `${format.initRange.start}-${format.initRange.end}` : "",
        index: format.indexRange ? `${format.indexRange.start}-${format.indexRange.end}` : "",
        bitrate: String(format.bitrate ?? 0),
        url: format.url ?? "",
        itag: String(format.itag ?? 0),
        type: format.mimeType ?? "",
        clen: format.contentLength ? String(format.contentLength) : "",
        lmt: format.lastModified ? String(format.lastModified) : "",
        projectionType: format.projectionType ?? "RECTANGULAR",
        container,
        encoding,
        audioQuality: format.audioQuality ?? "",
        audioSampleRate: format.audioSampleRate ? parseInt(format.audioSampleRate) : 0,
        audioChannels: format.audioChannels ?? 0,
        resolution: format.qualityLabel ?? "",
        qualityLabel: format.qualityLabel ?? "",
        quality: format.quality ?? "medium",
    };
}

function convertFormatStream(format: any): FormatStream {
    const { container, encoding } = mimeToContainerEncoding(format.mimeType);
    return {
        url: format.url ?? "",
        itag: String(format.itag ?? 0),
        type: format.mimeType ?? "",
        quality: format.quality ?? "medium",
        bitrate: String(format.bitrate ?? 0),
        fps: format.fps ?? 0,
        size: format.width && format.height ? `${format.width}x${format.height}` : "",
        resolution: format.qualityLabel ?? "",
        qualityLabel: format.qualityLabel ?? "",
        container,
        encoding,
        clen: format.contentLength ? String(format.contentLength) : "",
    };
}

function descriptionToHtml(description: string): string {
    if (!description) return "";
    let html = description
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    html = html.replace(
        /(https?:\/\/[^\s]+)/g,
        (url) => `<a href="${url}">${url.replace(/^https?:\/\//, "")}</a>`,
    );
    html = html.replace(/#(\w+)/g, '<a href="/hashtag/$1">#$1</a>');
    return html;
}

function getRelativeTimeString(date: Date): string {
    const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000);
    const diffYears = Math.floor(diffDays / 365);
    const diffMonths = Math.floor(diffDays / 30);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffHours = Math.floor((Date.now() - date.getTime()) / 3600000);
    const diffMinutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (diffYears > 0) return `${diffYears} year${diffYears > 1 ? "s" : ""} ago`;
    if (diffMonths > 0) return `${diffMonths} month${diffMonths > 1 ? "s" : ""} ago`;
    if (diffWeeks > 0) return `${diffWeeks} week${diffWeeks > 1 ? "s" : ""} ago`;
    if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    if (diffMinutes > 0) return `${diffMinutes} minute${diffMinutes > 1 ? "s" : ""} ago`;
    return "just now";
}

function localizeUrl(url: string, config: any): string {
    if (!url) return url;
    try {
        const urlParsed = new URL(url);
        let queryParams = new URLSearchParams(urlParsed.search);
        queryParams.set("host", urlParsed.host);

        if (config.server.encrypt_query_params) {
            const publicParams = [...queryParams].filter(([key]) =>
                !["pot", "ip"].includes(key)
            );
            const privateParams = [...queryParams].filter(([key]) =>
                ["pot", "ip"].includes(key)
            );
            const encryptedParams = encryptQuery(JSON.stringify(privateParams), config);
            queryParams = new URLSearchParams(publicParams);
            queryParams.set("enc", "true");
            queryParams.set("data", encryptedParams);
        }

        return config.server.base_path + urlParsed.pathname + "?" + queryParams.toString();
    } catch {
        return url;
    }
}

/**
 * Helper to convert duration string (e.g., "3:42", "1:05:20") to seconds.
 */
function durationToSeconds(text: string): number {
    if (!text) return 0;
    const parts = text.split(":").map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
}

/**
 * Extract recommended/related videos from VideoInfo.watch_next_feed.
 * Handles CompactVideo, LockupView, and generic nodes with video_id.
 */
function extractRecommendedVideos(videoInfo: YT.VideoInfo): RecommendedVideo[] {
    const feed = videoInfo.watch_next_feed;
    if (!feed || feed.length === 0) return [];

    const results: RecommendedVideo[] = [];

    for (const item of feed) {
        const raw = item as any;

        // ── Strategy 1: proper CompactVideo node ──────────────────────────
        if (item.is(YTNodes.CompactVideo)) {
            const vid = item as YTNodes.CompactVideo;
            const vidId = vid.id ?? "";
            if (!vidId) continue;

            const thumbs: Thumbnail[] = (vid.thumbnails ?? []).map(
                (t: any, idx: number) => ({
                    quality: idx === 0 ? "high" : idx === 1 ? "medium" : "default",
                    url: t.url ?? "",
                    width: t.width ?? 0,
                    height: t.height ?? 0,
                }),
            );
            const publishedText: string = (vid as any).published?.text ?? "";
            results.push({
                videoId: vidId,
                title: vid.title?.text ?? "",
                videoThumbnails: thumbs.length > 0 ? thumbs : generateThumbnails(vidId),
                author: vid.author?.name ?? "",
                authorUrl: `/channel/${vid.author?.id ?? ""}`,
                authorId: vid.author?.id ?? "",
                authorVerified: (vid.author as any)?.is_verified ?? false,
                lengthSeconds: vid.duration?.seconds ?? 0,
                viewCountText: (vid.short_view_count as any)?.text ?? (vid as any).view_count?.text ?? "",
                published: publishedText,
                publishedText,
            });
            continue;
        }

        // ── Strategy 2: LockupView node ───────────────────────────────────
        if (item.type === "LockupView") {
            const vidId = raw.content_id;
            if (!vidId) continue;

            const title = raw.metadata?.title?.text ?? "";
            const thumbs: Thumbnail[] = (raw.content_image?.image ?? []).map(
                (t: any, idx: number) => ({
                    quality: idx === 0 ? "high" : idx === 1 ? "medium" : "default",
                    url: t.url ?? "",
                    width: t.width ?? 0,
                    height: t.height ?? 0,
                }),
            );

            // Duration from overlay badge (e.g. "3:42")
            let durationText = "";
            const overlays = raw.content_image?.overlays || [];
            for (const overlay of overlays) {
                if (overlay.badges) {
                    for (const badge of overlay.badges) {
                        if (badge.text) {
                            durationText = badge.text;
                            break;
                        }
                    }
                }
            }
            const lengthSeconds = durationToSeconds(durationText);

            // Metadata rows: [0] = Author, [1] = Views & Published
            const rows = raw.metadata?.metadata?.metadata_rows || [];
            const author = rows[0]?.metadata_parts?.[0]?.text?.text ?? "";

            // Author ID from avatar navigation endpoint
            const authorId = raw.metadata?.image?.renderer_context?.command_context?.on_tap?.payload?.browseId ?? "";

            const viewCountText = rows[1]?.metadata_parts?.[0]?.text?.text ?? "";
            const publishedText = rows[1]?.metadata_parts?.[1]?.text?.text ?? "";

            results.push({
                videoId: vidId,
                title,
                videoThumbnails: thumbs.length > 0 ? thumbs : generateThumbnails(vidId),
                author,
                authorUrl: authorId ? `/channel/${authorId}` : "",
                authorId,
                authorVerified: false, // LockupView verification status is tricky, assume false or check badge
                lengthSeconds,
                viewCountText,
                published: publishedText,
                publishedText,
            });
            continue;
        }

        // ── Strategy 3: generic fallback (any node with video_id) ─────────
        const vidId: string =
            raw.video_id ??
            raw.videoId ??
            raw.id ??
            raw.content?.video_id ??
            raw.content?.id ??
            "";
        if (!vidId || !/^[a-zA-Z0-9_-]{11}$/.test(vidId)) continue;

        // Try to extract thumbnail, title, author from wherever they may be
        const rawThumbs: any[] =
            raw.thumbnails ??
            raw.thumbnail?.thumbnails ??
            raw.content?.thumbnail?.thumbnails ??
            [];

        const thumbs: Thumbnail[] = rawThumbs.length > 0
            ? rawThumbs.map((t: any, idx: number) => ({
                quality: idx === 0 ? "high" : idx === 1 ? "medium" : "default",
                url: t.url ?? "",
                width: t.width ?? 0,
                height: t.height ?? 0,
            }))
            : generateThumbnails(vidId);

        const title: string =
            raw.title?.text ??
            raw.title ??
            raw.content?.title?.text ??
            raw.headline?.text ??
            "";
        const author: string =
            raw.author?.name ??
            raw.author ??
            raw.short_byline_text?.runs?.[0]?.text ??
            "";
        const authorId: string =
            raw.author?.id ??
            raw.channel_id ??
            raw.short_byline_text?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ??
            "";
        const publishedText: string =
            raw.published?.text ??
            raw.published_time_text?.simpleText ??
            "";

        results.push({
            videoId: vidId,
            title,
            videoThumbnails: thumbs,
            author,
            authorUrl: authorId ? `/channel/${authorId}` : "",
            authorId,
            authorVerified: raw.author?.is_verified ?? false,
            lengthSeconds: raw.duration?.seconds ?? raw.length_seconds ?? 0,
            viewCountText: raw.short_view_count?.text ?? raw.view_count?.text ?? "",
            published: publishedText,
            publishedText,
        });
    }

    return results;
}


// ─── Route ───────────────────────────────────────────────────────────────────

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

    if (config.jobs.youtube_session.po_token_enabled && !tokenMinter) {
        throw new HTTPException(503, {
            res: new Response(JSON.stringify({ error: TOKEN_MINTER_NOT_READY_MESSAGE })),
        });
    }

    // Fetch player data (cached, deciphered)
    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        tokenMinter: tokenMinter!,
        metrics,
    }) as any;

    // Build VideoInfo from cached player response (for streaming_data / basic_info / captions)
    const videoInfo = youtubeVideoInfo(innertubeClient, youtubePlayerResponseJson);

    if (videoInfo.playability_status?.status !== "OK") {
        throw new HTTPException(400, {
            res: new Response(JSON.stringify({
                error: "Video unavailable",
                reason: videoInfo.playability_status?.reason,
            })),
        });
    }

    // Fetch next (watch page) to get related videos — this is a lightweight call
    let fullVideoInfo: YT.VideoInfo | null = null;
    try {
        fullVideoInfo = await innertubeClient.getInfo(videoId);
    } catch (_) {
        // If this fails, we continue without related videos
    }

    // ── Raw YouTube fields ──────────────────────────────────────────────────
    const videoDetails = youtubePlayerResponseJson.videoDetails ?? {};
    const microformat = youtubePlayerResponseJson.microformat?.playerMicroformatRenderer ?? {};
    const streamingDataRaw = youtubePlayerResponseJson.streamingData ?? {};
    const captionsRaw = youtubePlayerResponseJson.captions ?? {};
    const storyboardsRaw = youtubePlayerResponseJson.storyboards ?? {};
    const playabilityStatus = youtubePlayerResponseJson.playabilityStatus ?? {};

    // ── Published date ──────────────────────────────────────────────────────
    let publishedTimestamp = 0;
    let publishedText = "";
    if (microformat.publishDate) {
        const publishDate = new Date(microformat.publishDate);
        publishedTimestamp = Math.floor(publishDate.getTime() / 1000);
        publishedText = getRelativeTimeString(publishDate);
    }

    // ── Thumbnails ──────────────────────────────────────────────────────────
    const videoThumbnails: Thumbnail[] = generateThumbnails(videoId);

    // ── Storyboards ─────────────────────────────────────────────────────────
    const storyboards: Storyboard[] = parseStoryboards(storyboardsRaw, videoId);

    // ── Author thumbnails ────────────────────────────────────────────────────
    const authorThumbnails: AuthorThumbnail[] = [32, 48, 76, 100, 176, 512].map((sz) => ({
        url: `https://yt3.ggpht.com/a/default-user=s${sz}-c-k-c0x00ffffff-no-rj`,
        width: sz,
        height: sz,
    }));

    // ── Adaptive formats ─────────────────────────────────────────────────────
    const adaptiveFormats: AdaptiveFormat[] = (streamingDataRaw.adaptiveFormats ?? []).map(
        (f: any) => {
            const fmt = convertAdaptiveFormat(f);
            return fmt;
        },
    );

    // ── Format streams ────────────────────────────────────────────────────────
    const formatStreams: FormatStream[] = (streamingDataRaw.formats ?? []).map((f: any) => {
        const fmt = convertFormatStream(f);
        return fmt;
    });

    // ── Captions ──────────────────────────────────────────────────────────────
    const captions: any[] = (
        captionsRaw.playerCaptionsTracklistRenderer?.captionTracks ?? []
    ).map((track: any) => ({
        label: track.name?.simpleText ?? track.languageCode,
        language_code: track.languageCode,
        url: `/api/v1/captions/${videoId}?label=${encodeURIComponent(
            track.name?.simpleText ?? track.languageCode ?? "",
        )}`,
    }));

    // ── Recommended videos ─────────────────────────────────────────────────
    const recommendedVideos: RecommendedVideo[] = fullVideoInfo
        ? extractRecommendedVideos(fullVideoInfo)
        : [];

    // ── DASH manifest URL ──────────────────────────────────────────────────
    const dashUrl = `/api/manifest/dash/id/${videoId}`;

    // ── Genre / family safe ────────────────────────────────────────────────
    const genre: string = microformat.category ?? "";
    const isFamilyFriendly: boolean = microformat.isFamilySafe ?? true;
    const allowedRegions: string[] = microformat.availableCountries ?? [];

    // ── Sub count ─────────────────────────────────────────────────────────
    const subCountText: string =
        (fullVideoInfo as any)?.secondary_info?.owner?.subscriber_count?.text ?? "";

    // ── Build final Invidious-compatible response ──────────────────────────
    const response = {
        type: "video",
        title: videoDetails.title ?? "",
        videoId: videoDetails.videoId ?? videoId,
        videoThumbnails,
        storyboards,
        description: videoDetails.shortDescription ?? "",
        descriptionHtml: descriptionToHtml(videoDetails.shortDescription ?? ""),
        published: publishedTimestamp,
        publishedText,
        keywords: videoDetails.keywords ?? [],
        viewCount: parseInt(videoDetails.viewCount ?? "0"),
        likeCount: 0,
        dislikeCount: 0,
        paid: false,
        premium: false,
        isFamilyFriendly,
        allowedRegions,
        genre,
        genreUrl: null,
        author: videoDetails.author ?? "",
        authorId: videoDetails.channelId ?? "",
        authorUrl: `/channel/${videoDetails.channelId ?? ""}`,
        authorVerified: false,
        authorThumbnails,
        subCountText,
        lengthSeconds: parseInt(videoDetails.lengthSeconds ?? "0"),
        allowRatings: videoDetails.allowRatings ?? true,
        rating: 0,
        isListed: !(videoDetails.isPrivate ?? false),
        liveNow: videoDetails.isLiveContent ?? false,
        isPostLiveDvr: playabilityStatus.status === "OK" && (videoDetails.isLiveContent ?? false),
        isUpcoming: playabilityStatus.status === "LIVE_STREAM_OFFLINE",
        dashUrl,
        adaptiveFormats,
        formatStreams,
        captions,
        recommendedVideos,
    };

    return c.json(response);
});

export default videos;
