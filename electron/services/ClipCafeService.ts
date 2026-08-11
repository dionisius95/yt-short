import type { ClipCafeVideoResult, ClipCafeMovieResult, ClipCafeGenreMoviesResponse, ClipCafeMovieClipsResponse } from '../../shared/types';
import { createLogger } from '../utils/logger';

const log = createLogger('ClipCafeService');
const BASE_URL = 'https://clip.cafe';

export class ClipCafeService {
  /**
   * Search for movie clips on Clip.Cafe
   */
  async search(query: string): Promise<ClipCafeVideoResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const url = `${BASE_URL}/s/${encodeURIComponent(cleanQuery)}`;
    log.info({ query: cleanQuery, url }, 'Searching Clip.Cafe');

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        throw new Error(`Clip.Cafe search HTTP error: ${response.status}`);
      }

      const html = await response.text();
      return this.parseSearchResults(html);
    } catch (err) {
      log.error({ err }, 'Error searching Clip.Cafe');
      throw err;
    }
  }

  /**
   * Resolve direct MP4 download link and metadata from clip page
   */
  async resolveClipMetadata(clipUrl: string): Promise<{ directUrl: string; title: string; durationSeconds: number }> {
    let fullUrl = clipUrl;
    if (!clipUrl.startsWith('http')) {
      const cleanPath = clipUrl.startsWith('/') ? clipUrl.slice(1) : clipUrl;
      fullUrl = `${BASE_URL}/${cleanPath}`;
    }

    log.info({ url: fullUrl }, 'Resolving Clip.Cafe video metadata');

    try {
      const response = await fetch(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        throw new Error(`Clip.Cafe page HTTP error: ${response.status}`);
      }

      const html = await response.text();

      // 1. Extract direct video URL
      const contentUrlMatch = /"contentUrl":\s*"([^"]+)"/.exec(html);
      const sourceMatch = /<source\s+src="([^"]+)"\s+type="video\/mp4"/.exec(html);
      const directUrl = contentUrlMatch?.[1] || sourceMatch?.[1];

      if (!directUrl) {
        throw new Error('Could not find direct video URL in page');
      }

      // 2. Extract Title / Dialogue
      const titleMatch = /<h1>([^<]+)<\/h1>/.exec(html);
      const videoObjectTitleMatch = /"@type":\s*"VideoObject",\s*"name":\s*"([^"]+)"/.exec(html);
      const rawTitle = titleMatch?.[1] || videoObjectTitleMatch?.[1] || 'Clip.Cafe Clip';
      const cleanTitle = rawTitle.replace(/\r?\n|\r/g, ' ').trim();

      // 3. Extract Movie Name for context
      const movieMatch = /"isPartOf":\s*{\s*"@type":\s*"Movie",\s*"name":\s*"([^"]+)"/.exec(html);
      const movieTitle = movieMatch?.[1] || '';
      const finalTitle = movieTitle ? `"${cleanTitle}" (${movieTitle})` : cleanTitle;

      // 4. Extract Duration
      // Duration format in JSON-LD is usually: "duration" : "P0DT0H0M5S" -> extract seconds
      const durationMatch = /"duration"\s*:\s*"P0DT0H0M(\d+)S"/.exec(html);
      let durationSeconds = 5; // default fallback
      if (durationMatch?.[1]) {
        durationSeconds = parseInt(durationMatch[1], 10);
      } else {
        // Try alternate parsing
        const videoDurationSpanMatch = /<span class="videoDuration">([^<]+)<\/span>/.exec(html);
        if (videoDurationSpanMatch?.[1]) {
          const parts = videoDurationSpanMatch[1].split(':');
          if (parts.length === 2) {
            durationSeconds = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
          }
        }
      }

      return {
        directUrl,
        title: finalTitle,
        durationSeconds,
      };
    } catch (err) {
      log.error({ err, url: fullUrl }, 'Error resolving Clip.Cafe metadata');
      throw err;
    }
  }

  /**
   * Parse HTML search results page
   */
  private parseSearchResults(html: string): ClipCafeVideoResult[] {
    const results: ClipCafeVideoResult[] = [];
    
    // Split HTML by searchResultClip container
    const parts = html.split('<div class="searchResultClip">');
    if (parts.length <= 1) return [];

    // Skip the first part (preamble)
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];

      // 1. Extract link
      // e.g. <a href="the-matrix-resurrections-2021/you-say-matrix-to-anyone-you-say-matrix/" ...
      const linkMatch = /href="([^"]+)"/.exec(part);
      if (!linkMatch) continue;
      const urlPath = linkMatch[1];
      const clipId = urlPath.split('/').filter(Boolean).pop() || `clip-${i}`;

      // 2. Extract thumbnail
      // e.g. <img src="https://clip.cafe/img800/you-say-matrix-to-anyone-you-say-matrix.jpg" ...
      const thumbMatch = /src="(https:\/\/clip\.cafe\/img[^"]+)"/.exec(part);
      const thumbnail = thumbMatch?.[1] || '';

      // 3. Extract duration
      // e.g. <span class="videoDuration">00:05</span>
      const durationMatch = /<span class="videoDuration">([^<]+)<\/span>/.exec(part);
      const durationStr = durationMatch?.[1] || '00:05';
      const durParts = durationStr.split(':');
      const durationSeconds = durParts.length === 2 
        ? parseInt(durParts[0], 10) * 60 + parseInt(durParts[1], 10)
        : 5;

      // 4. Extract movie title & year
      // e.g. <div class="clipMovie"><a href="the-matrix-resurrections-2021">The Matrix Resurrections</a> • 2021</div>
      const movieMatch = /clipMovie"><a[^>]*>([^<]+)<\/a>\s*•\s*(\d+)/.exec(part);
      const movieTitle = movieMatch?.[1]?.trim() || 'Unknown Movie';
      const movieYear = movieMatch?.[2] ? parseInt(movieMatch[2], 10) : 0;

      // 5. Extract transcript
      // e.g. <div class="clipTrans"><p><b>Transcript:</b><br>You say <u>Matrix</u>...</p></div>
      const transcriptMatch = /clipTrans"><p><b>Transcript:<\/b><br>(.*?)<\/p><\/div>/s.exec(part);
      let transcript = '';
      if (transcriptMatch?.[1]) {
        // Strip HTML tags (like <u>, </u>, <br />) and trim
        transcript = transcriptMatch[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      results.push({
        clipId,
        url: `${BASE_URL}/${urlPath}`,
        title: transcript || movieTitle,
        movieTitle,
        movieYear,
        thumbnail,
        durationSeconds,
      });
    }

    return results;
  }

  /**
   * Get list of movies for a specific genre/category
   */
  async getGenreMovies(genre: string, page = 1): Promise<ClipCafeGenreMoviesResponse> {
    if (!genre) return { movies: [], currentPage: 1, totalPages: 1 };
    
    const url = page > 1 
      ? `${BASE_URL}/t/${encodeURIComponent(genre)}/${page}`
      : `${BASE_URL}/t/${encodeURIComponent(genre)}`;
      
    log.info({ genre, url, page }, 'Fetching genre movies from Clip.Cafe');

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        throw new Error(`Clip.Cafe genre HTTP error: ${response.status}`);
      }

      const html = await response.text();
      const movies = this.parseGenreMovies(html);
      
      const totalPagesMatch = /data-total="(\d+)"/.exec(html) || /max="(\d+)"/.exec(html) || /of (\d+)/i.exec(html);
      const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1], 10) : 1;

      return {
        movies,
        currentPage: page,
        totalPages,
      };
    } catch (err) {
      log.error({ err, genre, page }, 'Error fetching genre movies');
      throw err;
    }
  }

  /**
   * Get list of clips from a specific movie page
   */
  async getMovieClips(movieUrl: string, page = 1): Promise<ClipCafeMovieClipsResponse> {
    let fullUrl = movieUrl;
    if (!movieUrl.startsWith('http')) {
      const cleanPath = movieUrl.startsWith('/') ? movieUrl.slice(1) : movieUrl;
      fullUrl = `${BASE_URL}/${cleanPath}`;
    }

    if (page > 1) {
      if (fullUrl.endsWith('/')) {
        fullUrl = `${fullUrl.slice(0, -1)}/${page}/`;
      } else {
        fullUrl = `${fullUrl}/${page}/`;
      }
    }

    log.info({ url: fullUrl, page }, 'Fetching movie clips from Clip.Cafe');

    try {
      const response = await fetch(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        throw new Error(`Clip.Cafe movie page HTTP error: ${response.status}`);
      }

      const html = await response.text();
      const clips = this.parseMovieClips(html);

      const totalPagesMatch = /data-total="(\d+)"/.exec(html) || /max="(\d+)"/.exec(html) || /of (\d+)/i.exec(html);
      const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1], 10) : 1;

      return {
        clips,
        currentPage: page,
        totalPages,
      };
    } catch (err) {
      log.error({ err, url: fullUrl, page }, 'Error fetching movie clips');
      throw err;
    }
  }

  private parseGenreMovies(html: string): ClipCafeMovieResult[] {
    const movies: ClipCafeMovieResult[] = [];
    const regex = /<a href="([^"]+)" class="moviePosterBox[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    
    while ((match = regex.exec(html)) !== null) {
      const urlPath = match[1];
      const innerHtml = match[2];
      
      const titleMatch = /movieTitle">([^<]+)<\/span>/.exec(innerHtml);
      const posterMatch = /data-src="([^"]+)"/.exec(innerHtml) || /srcset="([^"]+)"/.exec(innerHtml) || /src="([^"]+)"/.exec(innerHtml);
      
      if (titleMatch) {
        const url = urlPath.startsWith('http') ? urlPath : `${BASE_URL}/${urlPath.startsWith('/') ? urlPath.slice(1) : urlPath}`;
        let poster = posterMatch ? posterMatch[1] : '';
        if (poster && !poster.startsWith('http')) {
          poster = `${BASE_URL}/${poster.startsWith('/') ? poster.slice(1) : poster}`;
        }
        
        movies.push({
          url,
          title: titleMatch[1].trim(),
          poster,
        });
      }
    }
    
    return movies;
  }

  private parseMovieClips(html: string): ClipCafeVideoResult[] {
    const clips: ClipCafeVideoResult[] = [];
    const parts = html.split('class="clip-card-collect-wrapper"');
    
    const movieTitleMatch = /<meta property="og:title" content="([^"]+)"/.exec(html);
    const movieTitle = movieTitleMatch ? movieTitleMatch[1].trim() : 'Unknown Movie';
    
    const yearMatch = /"releaseYear":\s*(\d+)/.exec(html) || /"datePublished":\s*"(\d+)/.exec(html) || /- (\d+)<\/title>/.exec(html);
    const movieYear = yearMatch ? parseInt(yearMatch[1], 10) : 0;

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      
      const hrefMatch = /href="([^"]+)"/.exec(part);
      if (!hrefMatch) continue;
      const urlPath = hrefMatch[1];
      const clipId = urlPath.split('/').filter(Boolean).pop() || `clip-${i}`;
      
      const thumbMatch = /data-src="(https:\/\/clip\.cafe\/img[^"]+)"/.exec(part) || /src="(https:\/\/clip\.cafe\/img[^"]+)"/.exec(part);
      const thumbnail = thumbMatch ? thumbMatch[1] : '';
      
      const durationMatch = /videoDuration">([^<]+)<\/span>/.exec(part);
      const durationStr = durationMatch ? durationMatch[1] : '00:05';
      const durParts = durationStr.split(':');
      const durationSeconds = durParts.length === 2 
        ? parseInt(durParts[0], 10) * 60 + parseInt(durParts[1], 10)
        : 5;
        
      const titleMatch = /clipTitle" title="([^"]+)"/.exec(part);
      let quote = titleMatch ? titleMatch[1] : '';
      quote = quote
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

      clips.push({
        clipId,
        url: urlPath.startsWith('http') ? urlPath : `${BASE_URL}/${urlPath.startsWith('/') ? urlPath.slice(1) : urlPath}`,
        title: quote || movieTitle,
        movieTitle,
        movieYear,
        thumbnail,
        durationSeconds,
      });
    }

    return clips;
  }
}
