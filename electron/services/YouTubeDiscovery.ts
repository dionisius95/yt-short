/**
 * YouTubeDiscovery — in-app video search & trending via YouTube Data API v3.
 *
 * Powers the Dashboard "Discover" panel so users can find source videos and
 * import them directly into the pipeline. These are read-only public-data
 * calls and only require an API key (no OAuth).
 *
 * NOTE: discovering a video here does NOT grant rights to reuse it. Importing
 * and re-clipping someone else's video may still trigger Content ID claims if
 * you don't own/license the material.
 */

import type {
  YouTubeVideoResult,
  YouTubeSearchParams,
  YouTubeTrendingParams,
} from '../../shared/types';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

interface RawThumb { url?: string }
interface RawSnippet {
  title?: string;
  channelTitle?: string;
  publishedAt?: string;
  thumbnails?: Record<string, RawThumb | undefined>;
}
interface RawStatistics { viewCount?: string; likeCount?: string }
interface RawContentDetails { duration?: string }
interface RawVideoItem {
  id?: string | { videoId?: string };
  snippet?: RawSnippet;
  statistics?: RawStatistics;
  contentDetails?: RawContentDetails;
}
interface RawListResponse { items?: RawVideoItem[] }

/** Parse an ISO-8601 duration (e.g. "PT1H2M30S") into total seconds. */
function parseISODuration(iso: string): number | null {
  if (!iso) return null;
  const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const h = parseInt(m[1] ?? '0', 10);
  const min = parseInt(m[2] ?? '0', 10);
  const s = parseInt(m[3] ?? '0', 10);
  return h * 3600 + min * 60 + s;
}

async function ytFetch(
  resource: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<RawListResponse> {
  const qs = new URLSearchParams({ ...params, key: apiKey }).toString();
  const res = await fetch(`${API_BASE}/${resource}?${qs}`).catch((err: unknown) => {
    throw new Error(`YOUTUBE_NETWORK_ERROR: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? '';
    } catch { /* ignore parse error */ }
    throw new Error(`YOUTUBE_API_ERROR: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await res.json()) as RawListResponse;
}

function toResult(item: RawVideoItem): YouTubeVideoResult {
  const sn = item.snippet ?? {};
  const st = item.statistics ?? {};
  const cd = item.contentDetails ?? {};
  const thumbs = sn.thumbnails ?? {};
  const thumb = thumbs.medium ?? thumbs.high ?? thumbs.default ?? thumbs.standard;
  const videoId = typeof item.id === 'string' ? item.id : (item.id?.videoId ?? '');
  return {
    videoId,
    url: 'https://www.youtube.com/watch?v=' + videoId,
    title: sn.title ?? '',
    channelTitle: sn.channelTitle ?? '',
    thumbnail: thumb?.url ?? '',
    publishedAt: sn.publishedAt ?? '',
    viewCount: st.viewCount != null ? Number(st.viewCount) : null,
    likeCount: st.likeCount != null ? Number(st.likeCount) : null,
    durationSeconds: parseISODuration(cd.duration ?? ''),
  };
}

/** Hydrate a list of video IDs with snippet/statistics/contentDetails. */
async function hydrate(ids: string[], apiKey: string): Promise<YouTubeVideoResult[]> {
  if (ids.length === 0) return [];
  const data = await ytFetch('videos', {
    part: 'snippet,statistics,contentDetails',
    id: ids.join(','),
    maxResults: String(ids.length),
  }, apiKey);
  return (data.items ?? []).map(toResult);
}

/** Keyword search. Returns videos ordered by the requested order. */
export async function searchYouTube(
  params: YouTubeSearchParams,
  apiKey: string,
): Promise<YouTubeVideoResult[]> {
  if (!apiKey) throw new Error('YOUTUBE_API_KEY_MISSING');
  const q = (params.query ?? '').trim();
  if (!q) return [];

  const search: Record<string, string> = {
    part: 'snippet',
    q,
    type: 'video',
    order: params.order ?? 'relevance',
    maxResults: String(Math.min(Math.max(params.maxResults ?? 24, 1), 50)),
  };
  if (params.regionCode) search.regionCode = params.regionCode;
  if (params.relevanceLanguage) search.relevanceLanguage = params.relevanceLanguage;

  const data = await ytFetch('search', search, apiKey);
  const ids = (data.items ?? [])
    .map((i) => (typeof i.id === 'string' ? i.id : i.id?.videoId))
    .filter((v): v is string => Boolean(v));
  return hydrate(ids, apiKey);
}

/** Most-popular (trending) videos for a region/audience and optional category. */
export async function getTrending(
  params: YouTubeTrendingParams,
  apiKey: string,
): Promise<YouTubeVideoResult[]> {
  if (!apiKey) throw new Error('YOUTUBE_API_KEY_MISSING');
  const p: Record<string, string> = {
    part: 'snippet,statistics,contentDetails',
    chart: 'mostPopular',
    regionCode: params.regionCode ?? 'US',
    maxResults: String(Math.min(Math.max(params.maxResults ?? 24, 1), 50)),
  };
  if (params.categoryId) p.videoCategoryId = params.categoryId;
  const data = await ytFetch('videos', p, apiKey);
  return (data.items ?? []).map(toResult);
}
