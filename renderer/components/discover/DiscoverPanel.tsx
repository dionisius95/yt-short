'use client';

/**
 * DiscoverPanel — in-app YouTube discovery & Viral/RPM Prediction.
 *
 *  • "Sedang Tren"  — most-popular videos per audience/region (videos.list chart=mostPopular)
 *  • "Cari Video"   — keyword search (search.list)
 *  • "Analisa Viral & RPM" — predict viral topics and high-RPM niches for US/UK with 3s hooks.
 *
 * Requires a YouTube Data API v3 key (Settings → YouTube Account).
 */

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ipc } from '../../lib/ipc-client';
import { cn } from '../../lib/utils';
import type { YouTubeVideoResult, TrendAnalysisResult, GistOptimizationResult, ClipCafeVideoResult, ClipCafeMovieResult } from '../../../shared/types';

type Mode = 'search' | 'trending' | 'viral-prediction' | 'clipcafe';
type SortOption = 'default' | 'duration-longest' | 'duration-shortest' | 'popularity' | 'title';

const REGIONS: { code: string; label: string; adsense?: boolean }[] = [
  { code: 'ID', label: 'Indonesia' },
  { code: 'US', label: 'Amerika Serikat', adsense: true },
  { code: 'GB', label: 'Inggris', adsense: true },
  { code: 'CA', label: 'Kanada', adsense: true },
  { code: 'AU', label: 'Australia', adsense: true },
  { code: 'DE', label: 'Jerman', adsense: true },
  { code: 'IN', label: 'India' },
  { code: 'JP', label: 'Jepang' },
  { code: 'BR', label: 'Brasil' },
  { code: 'PH', label: 'Filipina' },
];

const CATEGORIES: { id: string; label: string }[] = [
  { id: '', label: 'Semua kategori' },
  { id: '10', label: 'Musik' },
  { id: '20', label: 'Gaming' },
  { id: '24', label: 'Hiburan' },
  { id: '23', label: 'Komedi' },
  { id: '25', label: 'Berita & Politik' },
  { id: '22', label: 'People & Blogs' },
  { id: '17', label: 'Olahraga' },
  { id: '28', label: 'Sains & Teknologi' },
  { id: '26', label: 'Howto & Style' },
];

const CLIPCAFE_GENRES: { id: string; label: string }[] = [
  { id: '', label: 'Semua Genre' },
  { id: 'action', label: 'Action' },
  { id: 'adult', label: 'Adult' },
  { id: 'adventure', label: 'Adventure' },
  { id: 'animation', label: 'Animation' },
  { id: 'biography', label: 'Biography' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'crime', label: 'Crime' },
  { id: 'documentary', label: 'Documentary' },
  { id: 'drama', label: 'Drama' },
  { id: 'family', label: 'Family' },
  { id: 'fantasy', label: 'Fantasy' },
  { id: 'film-noir', label: 'Film-Noir' },
  { id: 'history', label: 'History' },
  { id: 'horror', label: 'Horror' },
  { id: 'music', label: 'Music' },
  { id: 'musical', label: 'Musical' },
  { id: 'mystery', label: 'Mystery' },
  { id: 'news', label: 'News' },
  { id: 'reality-tv', label: 'Reality-TV' },
  { id: 'romance', label: 'Romance' },
  { id: 'sci-fi', label: 'Sci-Fi' },
  { id: 'short', label: 'Short Film' },
  { id: 'sport', label: 'Sport' },
  { id: 'talk-show', label: 'Talk-Show' },
  { id: 'thriller', label: 'Thriller' },
  { id: 'war', label: 'War' },
  { id: 'western', label: 'Western' },
];

function formatViews(n: number | null): string {
  if (n == null) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}jt`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}rb`;
  return String(n);
}

function formatDur(s: number | null): string {
  if (s == null) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export function DiscoverPanel({ className }: { className?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('trending');
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('ID');
  const [category, setCategory] = useState('');
  const [results, setResults] = useState<YouTubeVideoResult[]>([]);
  const [clipCafeResults, setClipCafeResults] = useState<ClipCafeVideoResult[]>([]);
  const [clipCafeGenre, setClipCafeGenre] = useState('');
  const [clipCafeMovies, setClipCafeMovies] = useState<ClipCafeMovieResult[]>([]);
  const [activeMovieSlug, setActiveMovieSlug] = useState<string | null>(null);
  const [activeMovieTitle, setActiveMovieTitle] = useState<string>('');
  const [activeMovieUrl, setActiveMovieUrl] = useState<string | null>(null);
  const [clipCafeMoviePage, setClipCafeMoviePage] = useState(1);
  const [clipCafeMovieTotalPages, setClipCafeMovieTotalPages] = useState(1);
  const [clipCafeClipsPage, setClipCafeClipsPage] = useState(1);
  const [clipCafeClipsTotalPages, setClipCafeClipsTotalPages] = useState(1);
  const [sortBy, setSortBy] = useState<SortOption>('default');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsApiKey, setNeedsApiKey] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // Viral/RPM predictor states
  const [trendInput, setTrendInput] = useState('');
  const [analysisResult, setAnalysisResult] = useState<TrendAnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // G.I.S.T. Uniqueness Auditor states
  const [userScript, setUserScript] = useState('');
  const [auditing, setAuditing] = useState(false);

  // G.I.S.T. Optimizer states
  const [optimizing, setOptimizing] = useState(false);
  const [optimizationResult, setOptimizationResult] = useState<GistOptimizationResult | null>(null);
  const run = useCallback(async (nextMode?: Mode, overrideGenre?: string, overridePage?: number) => {
    const activeMode = nextMode ?? mode;
    const activeGenre = overrideGenre !== undefined ? overrideGenre : clipCafeGenre;
    const activePage = overridePage !== undefined ? overridePage : 1;
    if (activeMode === 'search' && query.trim().length === 0) return;
    if (activeMode === 'clipcafe' && query.trim().length === 0 && !activeGenre) return;
    setLoading(true);
    setError(null);
    setNeedsApiKey(false);
    setHasSearched(true);
    try {
      if (activeMode === 'clipcafe') {
        if (query.trim().length > 0) {
          const searchQuery = activeGenre ? `${query.trim()} ${activeGenre}` : query.trim();
          const data = await ipc.clipCafe.search(searchQuery);
          setClipCafeResults(data);
          setClipCafeMovies([]);
          setActiveMovieSlug(null);
          setActiveMovieUrl(null);
        } else {
          const res = await ipc.clipCafe.getGenreMovies(activeGenre, activePage);
          setClipCafeMovies(res.movies);
          setClipCafeMoviePage(res.currentPage);
          setClipCafeMovieTotalPages(res.totalPages);
          setClipCafeResults([]);
          setActiveMovieSlug(null);
          setActiveMovieUrl(null);
        }
      } else {
        const data = activeMode === 'search'
          ? await ipc.youtube.search({
              query: query.trim(),
              regionCode: region,
              relevanceLanguage: region === 'ID' ? 'id' : 'en',
              order: 'relevance',
              maxResults: 24,
            })
          : await ipc.youtube.trending({
              regionCode: region,
              categoryId: category || undefined,
              maxResults: 24,
            });
        setResults(data);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('YOUTUBE_API_KEY_MISSING')) {
        setNeedsApiKey(true);
      } else if (msg.includes('YOUTUBE_API_ERROR')) {
        setError('Gagal memanggil YouTube API. Pastikan API key valid & YouTube Data API v3 aktif (kuota harian juga mungkin habis).');
      } else if (msg.includes('YOUTUBE_NETWORK_ERROR')) {
        setError('Permintaan gagal — periksa koneksi internet.');
      } else {
        setError(msg);
      }
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [mode, query, region, category, clipCafeGenre]);

  const runAnalysis = useCallback(async (customTopic?: string, customDesc?: string, customScript?: string) => {
    const targetTopic = (customTopic ?? trendInput).trim();
    if (!targetTopic) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisResult(null);
    setUserScript('');
    setOptimizationResult(null);
    try {
      const res = await ipc.youtube.analyzeTrend({
        topic: targetTopic,
        description: customDesc || '',
        regionCode: region,
        userScript: customScript || undefined
      });
      setAnalysisResult(res);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }, [trendInput, region]);

  const runGistAudit = useCallback(async () => {
    if (!analysisResult || userScript.trim().length === 0) return;
    setAuditing(true);
    setOptimizationResult(null);
    try {
      const res = await ipc.youtube.analyzeTrend({
        topic: analysisResult.topic,
        regionCode: region,
        userScript: userScript.trim(),
      });
      setAnalysisResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuditing(false);
    }
  }, [analysisResult, userScript, region]);

  const runGistOptimize = useCallback(async () => {
    if (!analysisResult || userScript.trim().length === 0) return;
    setOptimizing(true);
    setOptimizationResult(null);
    try {
      const res = await ipc.youtube.optimizeGist({
        topic: analysisResult.topic,
        userScript: userScript.trim()
      });
      setOptimizationResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOptimizing(false);
    }
  }, [analysisResult, userScript]);

  const handleImport = (url: string) => {
    router.push(`/import?url=${encodeURIComponent(url)}`);
  };

  const handleQuickAnalyze = (v: YouTubeVideoResult) => {
    setMode('viral-prediction');
    setTrendInput(v.title);
    setAnalysisResult(null);
    setAnalysisError(null);
    setUserScript('');
    setOptimizationResult(null);
    void runAnalysis(v.title, v.channelTitle);
  };

  const handleSelectMovie = async (movieUrl: string, movieTitle: string, page = 1) => {
    setLoading(true);
    setError(null);
    try {
      const res = await ipc.clipCafe.getMovieClips(movieUrl, page);
      setClipCafeResults(res.clips);
      setClipCafeClipsPage(res.currentPage);
      setClipCafeClipsTotalPages(res.totalPages);
      const slug = movieUrl.split('/').filter(Boolean).pop() || 'movie';
      setActiveMovieSlug(slug);
      setActiveMovieTitle(movieTitle);
      setActiveMovieUrl(movieUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setClipCafeResults([]);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setResults([]);
    setClipCafeResults([]);
    setClipCafeMovies([]);
    setActiveMovieSlug(null);
    setActiveMovieTitle('');
    setActiveMovieUrl(null);
    setClipCafeMoviePage(1);
    setClipCafeMovieTotalPages(1);
    setClipCafeClipsPage(1);
    setClipCafeClipsTotalPages(1);
    setSortBy('default');
    setClipCafeGenre('');
    setHasSearched(false);
    setError(null);
    setNeedsApiKey(false);
    setAnalysisResult(null);
    setAnalysisError(null);
    setUserScript('');
    setOptimizationResult(null);
    if (m === 'trending') void run('trending');
  };

  const sortedResults = [...results].sort((a, b) => {
    if (sortBy === 'duration-longest') {
      return (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
    }
    if (sortBy === 'duration-shortest') {
      return (a.durationSeconds ?? 0) - (b.durationSeconds ?? 0);
    }
    if (sortBy === 'popularity') {
      return (b.viewCount ?? 0) - (a.viewCount ?? 0);
    }
    if (sortBy === 'title') {
      return a.title.localeCompare(b.title);
    }
    return 0;
  });

  const sortedClipCafeResults = [...clipCafeResults].sort((a, b) => {
    if (sortBy === 'duration-longest') {
      return b.durationSeconds - a.durationSeconds;
    }
    if (sortBy === 'duration-shortest') {
      return a.durationSeconds - b.durationSeconds;
    }
    if (sortBy === 'title') {
      const movieCompare = a.movieTitle.localeCompare(b.movieTitle);
      if (movieCompare !== 0) return movieCompare;
      return a.title.localeCompare(b.title);
    }
    return 0;
  });

  return (
    <section className={cn('rounded-xl border border-border bg-surface p-5 shadow-sm', className)}>
      {/* Header + mode tabs */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Temukan & Analisis Video / Cuplikan</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Cari video tren, cuplikan film Clip.Cafe, analisa RPM tinggi luar negeri, lalu impor untuk Shorts.
          </p>
        </div>
        <div className="inline-flex rounded-md border border-border bg-background p-0.5">
          {([['trending', 'Sedang Tren'], ['search', 'Cari Video'], ['clipcafe', 'Cari Cuplikan (Clip.Cafe)'], ['viral-prediction', 'Analisa Viral & RPM']] as [Mode, string][]).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={cn(
                'rounded px-3 py-1.5 text-xs font-medium transition-micro',
                mode === m ? 'bg-accent text-accent-foreground shadow-sm' : 'text-text-secondary hover:text-text-primary'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {(mode === 'search' || mode === 'clipcafe') && (
          <form
            onSubmit={(e) => { e.preventDefault(); void run(mode); }}
            className="flex min-w-[220px] flex-1 gap-2"
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={mode === 'clipcafe' ? "Cari kutipan dialog atau judul film di Clip.Cafe..." : "Cari topik, kata kunci, atau channel…"}
              className={cn(
                'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
                'placeholder:text-text-secondary/50 focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
              )}
            />
            <button
              type="submit"
              disabled={loading || query.trim().length === 0}
              className={cn(
                'rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground',
                'hover:bg-accent-hover transition-micro disabled:opacity-40 disabled:cursor-not-allowed'
              )}
            >
              Cari
            </button>
          </form>
        )}

        {mode === 'viral-prediction' && (
          <form
            onSubmit={(e) => { e.preventDefault(); void runAnalysis(); }}
            className="flex min-w-[220px] flex-1 gap-2"
          >
            <input
              type="text"
              value={trendInput}
              onChange={(e) => setTrendInput(e.target.value)}
              placeholder="Masukkan topik kustom, kata kunci, atau judul video untuk dianalisis..."
              className={cn(
                'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary',
                'placeholder:text-text-secondary/50 focus:outline-none focus:ring-2 focus:ring-accent transition-micro'
              )}
            />
            <button
              type="submit"
              disabled={analyzing || trendInput.trim().length === 0}
              className={cn(
                'rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground',
                'hover:bg-accent-hover transition-micro disabled:opacity-40 disabled:cursor-not-allowed'
              )}
            >
              Mulai Analisa
            </button>
          </form>
        )}

        {mode !== 'viral-prediction' && mode !== 'clipcafe' && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-text-secondary">Target Audiens (RPM Tinggi)</span>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {REGIONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}{r.adsense ? ' • RPM tinggi 🔥' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {mode === 'trending' && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-text-secondary">Kategori</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </label>
        )}

        {mode === 'clipcafe' && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-text-secondary">Kategori Film / Genre</span>
            <select
              value={clipCafeGenre}
              onChange={(e) => {
                const val = e.target.value;
                setClipCafeGenre(val);
                if (val || query.trim().length > 0) {
                  void run('clipcafe', val);
                } else {
                  setClipCafeResults([]);
                  setHasSearched(false);
                }
              }}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {CLIPCAFE_GENRES.map((g) => (
                <option key={g.id} value={g.id}>{g.label}</option>
              ))}
            </select>
          </label>
        )}

        {mode !== 'viral-prediction' && mode !== 'clipcafe' && (
          <button
            type="button"
            onClick={() => void run()}
            disabled={loading || (mode === 'search' && query.trim().length === 0)}
            className={cn(
              'rounded-md border border-border px-3 py-2 text-sm font-medium text-text-primary',
              'hover:bg-accent/5 transition-micro disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            {mode === 'trending' ? 'Muat tren' : 'Terapkan'}
          </button>
        )}

        {(results.length > 0 || clipCafeResults.length > 0) && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-text-secondary">Urutkan</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="default">Relevansi</option>
              <option value="duration-longest">Durasi: Terpanjang</option>
              <option value="duration-shortest">Durasi: Terpendek</option>
              {mode !== 'clipcafe' && <option value="popularity">Popularitas</option>}
              <option value="title">{mode === 'clipcafe' ? 'Judul Film' : 'Judul Video'}</option>
            </select>
          </label>
        )}
      </div>

      {mode !== 'viral-prediction' && mode !== 'clipcafe' && (
        <p className="mb-4 text-[11px] text-text-secondary">
          💡 Audiens AS, Inggris, Kanada, Australia, dan Jerman umumnya memberi RPM/AdSense lebih tinggi dibanding Indonesia.
        </p>
      )}

      {needsApiKey && (
        <div className="mb-4 rounded-md border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-text-primary">
          <p className="font-medium">Butuh YouTube Data API key</p>
          <p className="mt-1 text-xs text-text-secondary">
            Fitur ini memakai YouTube Data API v3. Tambahkan API key di Settings → YouTube Account untuk mengaktifkan pencarian & video tren.
          </p>
          <button
            type="button"
            onClick={() => router.push('/settings')}
            className="mt-2 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent-hover transition-micro"
          >
            Buka Settings
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* SEARCH AND TRENDING RENDER */}
      {mode !== 'viral-prediction' && mode !== 'clipcafe' && (
        <>
          {loading && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="aspect-video w-full rounded-md bg-border/40" />
                  <div className="mt-2 h-3 w-3/4 rounded bg-border/40" />
                  <div className="mt-1.5 h-2.5 w-1/2 rounded bg-border/30" />
                </div>
              ))}
            </div>
          )}

          {!loading && results.length > 0 && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {sortedResults.map((v) => (
                <div key={v.videoId} className="flex flex-col overflow-hidden rounded-md border border-border bg-background">
                  <div className="relative aspect-video w-full overflow-hidden bg-border/30">
                    {v.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.thumbnail} alt={v.title} className="h-full w-full object-cover" loading="lazy" />
                    ) : null}
                    {v.durationSeconds != null && (
                      <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {formatDur(v.durationSeconds)}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1 p-2.5">
                    <p className="line-clamp-2 text-xs font-medium text-text-primary" title={v.title}>{v.title}</p>
                    <p className="truncate text-[11px] text-text-secondary">{v.channelTitle}</p>
                    {v.viewCount != null && (
                      <p className="text-[11px] text-text-secondary">{formatViews(v.viewCount)} x ditonton</p>
                    )}
                    <div className="mt-auto flex gap-1.5 pt-1.5">
                      <button
                        type="button"
                        onClick={() => handleImport(v.url)}
                        className="flex-1 rounded-md bg-accent px-2 py-1.5 text-[11px] font-medium text-accent-foreground hover:bg-accent-hover transition-micro"
                      >
                        Import
                      </button>
                      <button
                        type="button"
                        onClick={() => handleQuickAnalyze(v)}
                        className="rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] font-medium text-text-primary hover:bg-accent/5 transition-micro"
                        title="Analisa potensi viral & RPM"
                      >
                        🔍 Analisa
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && !error && !needsApiKey && hasSearched && results.length === 0 && (
            <p className="py-8 text-center text-sm text-text-secondary">Tidak ada hasil. Coba kata kunci atau audiens lain.</p>
          )}
        </>
      )}

      {/* CLIPCAFE MODE RENDER */}
      {mode === 'clipcafe' && (
        <>
          {loading && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="aspect-video w-full rounded-md bg-border/40" />
                  <div className="mt-2 h-3 w-3/4 rounded bg-border/40" />
                  <div className="mt-1.5 h-2.5 w-1/2 rounded bg-border/30" />
                </div>
              ))}
            </div>
          )}

          {!loading && clipCafeMovies.length > 0 && !activeMovieSlug && (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {clipCafeMovies.map((m) => (
                  <button
                    key={m.url}
                    type="button"
                    onClick={() => void handleSelectMovie(m.url, m.title)}
                    className="group flex flex-col overflow-hidden rounded-md border border-border bg-background text-left hover:border-accent hover:shadow-sm transition-micro"
                  >
                    <div className="relative aspect-[2/3] w-full overflow-hidden bg-border/30">
                      {m.poster ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.poster} alt={m.title} className="h-full w-full object-cover group-hover:scale-105 transition-all duration-300" loading="lazy" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-surface text-2xl">🎬</div>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-1 p-3">
                      <p className="line-clamp-2 text-xs font-bold text-text-primary group-hover:text-accent transition-micro" title={m.title}>
                        {m.title}
                      </p>
                      <span className="mt-auto text-[10px] font-semibold text-accent uppercase tracking-wider">
                        Lihat Klip →
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              {clipCafeMovieTotalPages > 1 && (
                <div className="mt-6 flex items-center justify-center gap-4">
                  <button
                    type="button"
                    disabled={clipCafeMoviePage <= 1 || loading}
                    onClick={() => void run('clipcafe', undefined, clipCafeMoviePage - 1)}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-accent/5 disabled:opacity-40 disabled:cursor-not-allowed transition-micro"
                  >
                    ← Sebelumnya
                  </button>
                  <span className="text-xs text-text-secondary">
                    Halaman {clipCafeMoviePage} dari {clipCafeMovieTotalPages}
                  </span>
                  <button
                    type="button"
                    disabled={clipCafeMoviePage >= clipCafeMovieTotalPages || loading}
                    onClick={() => void run('clipcafe', undefined, clipCafeMoviePage + 1)}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-accent/5 disabled:opacity-40 disabled:cursor-not-allowed transition-micro"
                  >
                    Selanjutnya →
                  </button>
                </div>
              )}
            </>
          )}

          {!loading && clipCafeResults.length > 0 && (
            <>
              {activeMovieSlug && (
                <div className="mb-4 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveMovieSlug(null);
                    }}
                    className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-accent/5 transition-micro"
                  >
                    ← Kembali ke Film
                  </button>
                  <span className="text-sm font-bold text-text-primary">
                    Klip Film: {activeMovieTitle}
                  </span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {sortedClipCafeResults.map((v) => (
                  <div key={v.clipId} className="flex flex-col overflow-hidden rounded-md border border-border bg-background">
                    <div className="relative aspect-video w-full overflow-hidden bg-border/30">
                      {v.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={v.thumbnail} alt={v.title} className="h-full w-full object-cover" loading="lazy" />
                      ) : null}
                      {v.durationSeconds != null && (
                        <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                          {formatDur(v.durationSeconds)}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-1 p-2.5">
                      <p className="line-clamp-3 text-xs font-semibold text-text-primary italic" title={v.title}>
                        "{v.title}"
                      </p>
                      <p className="mt-auto truncate text-[11px] font-medium text-accent">
                        {v.movieTitle} ({v.movieYear})
                      </p>
                      <div className="mt-2 flex gap-1.5 pt-1.5">
                        <button
                          type="button"
                          onClick={() => handleImport(v.url)}
                          className="flex-1 rounded-md bg-accent px-2 py-1.5 text-[11px] font-medium text-accent-foreground hover:bg-accent-hover transition-micro"
                        >
                          Import HD
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {clipCafeClipsTotalPages > 1 && activeMovieUrl && (
                <div className="mt-6 flex items-center justify-center gap-4">
                  <button
                    type="button"
                    disabled={clipCafeClipsPage <= 1 || loading}
                    onClick={() => activeMovieUrl && void handleSelectMovie(activeMovieUrl, activeMovieTitle, clipCafeClipsPage - 1)}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-accent/5 disabled:opacity-40 disabled:cursor-not-allowed transition-micro"
                  >
                    ← Sebelumnya
                  </button>
                  <span className="text-xs text-text-secondary">
                    Halaman {clipCafeClipsPage} dari {clipCafeClipsTotalPages}
                  </span>
                  <button
                    type="button"
                    disabled={clipCafeClipsPage >= clipCafeClipsTotalPages || loading}
                    onClick={() => activeMovieUrl && void handleSelectMovie(activeMovieUrl, activeMovieTitle, clipCafeClipsPage + 1)}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-accent/5 disabled:opacity-40 disabled:cursor-not-allowed transition-micro"
                  >
                    Selanjutnya →
                  </button>
                </div>
              )}
            </>
          )}

          {!loading && !error && hasSearched && clipCafeResults.length === 0 && clipCafeMovies.length === 0 && (
            <p className="py-8 text-center text-sm text-text-secondary">Tidak ada hasil. Coba kata kunci atau genre lain.</p>
          )}
        </>
      )}

      {/* VIRAL PREDICTION MODE RENDER */}
      {mode === 'viral-prediction' && (
        <div className="mt-3">
          {analyzing && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="relative flex h-16 w-16 items-center justify-center">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/25 opacity-75"></span>
                <div className="relative h-12 w-12 rounded-full border-4 border-accent border-t-transparent animate-spin"></div>
              </div>
              <p className="mt-4 text-sm font-semibold text-text-primary animate-pulse">Menghubungkan ke Engine...</p>
              <p className="text-xs text-text-secondary mt-1">Menganalisis kecocokan audiens US/UK & potensi iklan CPM tinggi...</p>
            </div>
          )}

          {analysisError && (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
              Gagal menganalisis topik: {analysisError}
            </div>
          )}

          {!analyzing && !analysisResult && (
            <div className="mb-4">
              <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
                <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Pilih Niche RPM Tinggi (Rekomendasi)</h3>
                <span className="text-[10px] text-accent font-medium">Berdasarkan data CPM AS/UK</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { name: 'Personal Finance & Investing', icon: '💰', rpm: '$20 - $45', desc: 'Investasi, Crypto, Pajak, Pendapatan Pasif, Real Estate.' },
                  { name: 'Artificial Intelligence & Tech Reviews', icon: '🤖', rpm: '$15 - $32', desc: 'AI Coding Agents, Chatbot, Software Reviews, Gadgets.' },
                  { name: 'Productivity & Psychology Hacks', icon: '🧠', rpm: '$10 - $22', desc: 'Fokus, Kebiasaan Sukses, Psikologi, Rutinitas Elit.' },
                  { name: 'True Crime & Deep Mysteries', icon: '🔍', rpm: '$6 - $15', desc: 'Kasus Misteri Kriminal, NASA & Luar Angkasa, Teori Konspirasi.' },
                ].map((n) => (
                  <button
                    key={n.name}
                    type="button"
                    onClick={() => {
                      setTrendInput(n.name);
                      void runAnalysis(n.name);
                    }}
                    className="flex flex-col items-start rounded-lg border border-border bg-background p-4 text-left hover:border-accent hover:bg-accent/5 transition-micro hover:shadow-sm"
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-lg">{n.icon}</span>
                      <span className="rounded bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success">{n.rpm} RPM</span>
                    </div>
                    <h4 className="mt-2 text-sm font-semibold text-text-primary">{n.name}</h4>
                    <p className="mt-1 text-xs text-text-secondary leading-relaxed">{n.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!analyzing && analysisResult && (
            <div className="space-y-6">
              {/* Score + Metrics Panel */}
              <div className="flex flex-col md:flex-row gap-4 items-stretch">
                {/* Visual Circle Score */}
                <div className="flex flex-col items-center justify-center rounded-xl bg-accent/5 border border-accent/15 p-5 md:w-52 text-center shrink-0">
                  <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Skor Potensi Viral</span>
                  <div className="relative flex h-28 w-28 items-center justify-center mt-3">
                    <svg className="absolute h-full w-full -rotate-90" viewBox="0 0 36 36">
                      <path
                        className="text-border/40"
                        strokeWidth="3.2"
                        stroke="currentColor"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                      <path
                        className="text-accent"
                        strokeWidth="3.5"
                        strokeDasharray={`${analysisResult.trendStrength}, 100`}
                        strokeLinecap="round"
                        stroke="currentColor"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                    </svg>
                    <span className="text-3xl font-extrabold text-text-primary">{analysisResult.trendStrength}%</span>
                  </div>
                  <span className="mt-3 text-xs font-bold text-success bg-success/15 px-2.5 py-0.5 rounded-full">
                    {analysisResult.trendStrength >= 85 ? 'Sangat Direkomendasikan 🔥' : 'Potensi Tinggi 👍'}
                  </span>
                </div>

                {/* Metrics Breakdown */}
                <div className="flex-1 flex flex-col justify-between rounded-xl border border-border bg-background p-5">
                  <div>
                    <div className="flex items-start justify-between flex-wrap gap-2">
                      <div>
                        <span className="text-[10px] font-bold text-accent uppercase tracking-wider">Laporan Analisis Topik</span>
                        <h3 className="text-base font-bold text-text-primary">{analysisResult.topic}</h3>
                      </div>
                      <div className="flex gap-2">
                        <span className="rounded bg-accent/15 px-2.5 py-1 text-xs font-extrabold text-accent">
                          RPM: {analysisResult.estimatedRpm}
                        </span>
                        <span className="rounded bg-success/15 px-2.5 py-1 text-xs font-bold text-success uppercase">
                          {analysisResult.rpmPotential.replace('_', ' ')} RPM
                        </span>
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-text-secondary leading-relaxed">
                      <strong className="text-text-primary">Kenapa Topik Ini Meledak:</strong> {analysisResult.whyViral}
                    </p>
                  </div>
                  <div className="mt-4 pt-3 border-t border-border/60">
                    <p className="text-xs text-text-secondary leading-relaxed">
                      <strong className="text-text-primary">Profil Audiens Target ({region}):</strong> {analysisResult.targetAudience}
                    </p>
                  </div>
                </div>
              </div>

              {/* G.I.S.T. Algorithm Audit Section */}
              <div className="rounded-xl border border-border bg-background p-5">
                <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-4 flex-wrap gap-2">
                  <div>
                    <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider flex items-center gap-1">
                      <span>🔬</span> Auditor Keunikan G.I.S.T. YouTube 2026
                    </h3>
                    <p className="text-[10px] text-text-secondary mt-0.5">Uji kesesuaian draf naskah agar lolos dari Conflict Radius ( views stuck 0-1k )</p>
                  </div>
                  <span className="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent">Token 7 & 8 Audit</span>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
                  {/* Left: Input script */}
                  <div className="space-y-3">
                    <label className="block text-[11px] font-semibold text-text-primary">
                      Tempel Draf Naskah / Kerangka Ide Kamu:
                    </label>
                    <textarea
                      rows={5}
                      value={userScript}
                      onChange={(e) => setUserScript(e.target.value)}
                      placeholder="Tempel draf pembuka video, hook 3 detik kustom, atau isi script kamu di sini untuk mengevaluasi Net Information Gain..."
                      className="w-full rounded-md border border-border bg-surface p-3 text-xs text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:ring-2 focus:ring-accent transition-micro resize-y"
                    />
                    <button
                      type="button"
                      disabled={auditing || userScript.trim().length === 0}
                      onClick={() => void runGistAudit()}
                      className="w-full rounded-md bg-accent py-2 text-xs font-semibold text-accent-foreground hover:bg-accent-hover transition-micro disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {auditing ? 'Mengaudit Keunikan...' : 'Mulai Audit Keunikan'}
                    </button>
                  </div>

                  {/* Right: Results Audit */}
                  <div className="rounded-lg border border-border/85 bg-surface p-4 min-h-[190px] flex flex-col justify-center">
                    {!analysisResult.gistAudit && !auditing && (
                      <div className="text-center py-6">
                        <span className="text-2xl opacity-60">📋</span>
                        <p className="text-xs text-text-secondary mt-2">Belum ada data audit. Masukkan draf naskah kamu di sebelah kiri untuk mendeteksi Conflict Radius.</p>
                      </div>
                    )}

                    {auditing && (
                      <div className="flex flex-col items-center justify-center py-6 text-center">
                        <div className="h-6 w-6 rounded-full border-2 border-accent border-t-transparent animate-spin"></div>
                        <p className="text-xs font-medium text-text-primary mt-2 animate-pulse">Menghitung Net Information Gain...</p>
                      </div>
                    )}

                    {!auditing && analysisResult.gistAudit && (
                      <div className="space-y-4">
                        {/* Status badges */}
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <span className="text-xs font-semibold text-text-primary">Status Jangkauan Konten:</span>
                          {analysisResult.gistAudit.conflictRadiusRisk === 'duplicate' && (
                            <span className="rounded bg-destructive/15 px-2.5 py-1 text-[11px] font-bold text-destructive">
                              Duplikat (Limit: 0 - 1k views) ⚠️
                            </span>
                          )}
                          {analysisResult.gistAudit.conflictRadiusRisk === 'somewhat_transformative' && (
                            <span className="rounded bg-amber-500/15 px-2.5 py-1 text-[11px] font-bold text-amber-500">
                              Agak Transformatif (Limit: ~30k views) ⚠️
                            </span>
                          )}
                          {analysisResult.gistAudit.conflictRadiusRisk === 'significantly_transformative' && (
                            <span className="rounded bg-success/15 px-2.5 py-1 text-[11px] font-bold text-success">
                              Significantly Transformative (No Limit) ✅
                            </span>
                          )}
                        </div>

                        {/* Progress bars */}
                        <div className="space-y-3 pt-2 border-t border-border/40">
                          <div>
                            <div className="flex items-center justify-between text-[11px] font-medium text-text-secondary mb-1">
                              <span>Net Information Gain (Token 7 & 8)</span>
                              <span className="font-bold text-text-primary">{analysisResult.gistAudit.netInformationGain}%</span>
                            </div>
                            <div className="h-2 w-full rounded bg-border/40 overflow-hidden">
                              <div 
                                className={cn(
                                  "h-full transition-all duration-300", 
                                  analysisResult.gistAudit.netInformationGain > 70 ? "bg-success" : 
                                  analysisResult.gistAudit.netInformationGain > 35 ? "bg-amber-500" : "bg-destructive"
                                )} 
                                style={{ width: `${analysisResult.gistAudit.netInformationGain}%` }}
                              />
                            </div>
                          </div>
                          
                          <div>
                            <div className="flex items-center justify-between text-[11px] font-medium text-text-secondary mb-1">
                              <span>Kemiripan Ide (Similarity Score)</span>
                              <span className="font-bold text-text-primary">{analysisResult.gistAudit.similarityScore}%</span>
                            </div>
                            <div className="h-2 w-full rounded bg-border/40 overflow-hidden">
                              <div 
                                className={cn(
                                  "h-full transition-all duration-300", 
                                  analysisResult.gistAudit.similarityScore > 75 ? "bg-destructive" : 
                                  analysisResult.gistAudit.similarityScore > 35 ? "bg-amber-500" : "bg-success"
                                )} 
                                style={{ width: `${analysisResult.gistAudit.similarityScore}%` }}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Overlaps details */}
                        <div className="text-[11px] space-y-2 pt-2 border-t border-border/40">
                          <p className="text-text-secondary leading-relaxed">
                            <strong className="text-text-primary">Token 7 (Idea Overlap):</strong> {analysisResult.gistAudit.originalIdeaOverlap}
                          </p>
                          <p className="text-text-secondary leading-relaxed">
                            <strong className="text-text-primary">Token 8 (Delivery Overlap):</strong> {analysisResult.gistAudit.deliveryOverlap}
                          </p>
                        </div>

                        {/* Diversity Action Plan */}
                        <div className="pt-2 border-t border-border/40">
                          <strong className="block text-[11px] text-text-primary mb-1">Taktik Agar Lolos Limit Algoritma (Significantly Transformative):</strong>
                          <ul className="list-disc list-inside text-[11px] text-text-secondary space-y-1.5 leading-relaxed pl-1">
                            {analysisResult.gistAudit.diversityActionPlan.map((step, idx) => (
                              <li key={idx}>{step}</li>
                            ))}
                          </ul>
                        </div>

                        {/* Automated G.I.S.T. Rewrite Panel */}
                        {analysisResult.gistAudit.conflictRadiusRisk !== 'significantly_transformative' && (
                          <div className="pt-3 border-t border-border/40 space-y-2.5">
                            <button
                              type="button"
                              disabled={optimizing}
                              onClick={() => void runGistOptimize()}
                              className="w-full rounded-md bg-accent/10 hover:bg-accent/20 border border-accent/30 py-2 text-xs font-semibold text-accent transition-micro flex items-center justify-center gap-1.5"
                            >
                              {optimizing ? (
                                <>
                                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                                  Mengoptimalkan Naskah...
                                </>
                              ) : (
                                <>✨ Optimasi Otomatis (G.I.S.T. Rewrite)</>
                              )}
                            </button>

                            {optimizationResult && (
                              <div className="rounded border border-success/30 bg-success/5 p-3 space-y-2 text-[11px] animate-fade-in text-left">
                                <div className="flex items-center justify-between text-success font-semibold">
                                  <span>Hasil Optimasi (Lolos G.I.S.T. / Hijau):</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setUserScript(optimizationResult.optimizedScript);
                                      setOptimizationResult(null);
                                    }}
                                    className="text-[10px] text-accent underline hover:no-underline"
                                  >
                                    Gunakan Naskah Baru
                                  </button>
                                </div>
                                <p className="italic text-text-primary bg-background/50 p-2 rounded max-h-24 overflow-y-auto font-mono">
                                  "{optimizationResult.optimizedScript}"
                                </p>
                                <p className="text-text-secondary leading-relaxed">
                                  <strong className="text-text-primary">Mengapa Ini Berhasil:</strong> {optimizationResult.explanation}
                                </p>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 3-Second Hooks Section */}
              <div className="rounded-xl border border-border bg-background p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">💡 Rekomendasi Hook 3 Detik Pertama (Pemicu Retensi Tinggi)</h3>
                  <span className="text-[10px] text-text-secondary">Script Bahasa Inggris</span>
                </div>
                <div className="space-y-4">
                  {analysisResult.hooks.map((h, i) => (
                    <div key={i} className="rounded-lg border border-border/80 bg-surface p-4">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <span className="rounded bg-accent/15 px-2 py-0.5 text-[10px] font-bold text-accent">
                          {h.hookType}
                        </span>
                        <span className="text-[10px] text-text-secondary font-medium">Strategi #{i + 1}</span>
                      </div>
                      <p className="mt-2.5 text-sm font-semibold italic text-text-primary text-left border-l-2 border-accent pl-3.5 leading-relaxed">
                        "{h.hookText}"
                      </p>
                      <p className="mt-3 text-xs text-text-secondary leading-relaxed">
                        <strong className="text-text-primary">Kenapa Berhasil (Psikologi):</strong> {h.whyItWorks}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Suggested Titles */}
              <div className="rounded-xl border border-border bg-background p-5">
                <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">📈 Judul CTR Tinggi yang Disarankan</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {analysisResult.suggestedTitles.map((t, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-lg border border-border/80 bg-surface p-3 text-left">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">
                        {i + 1}
                      </span>
                      <span className="text-xs font-semibold text-text-primary leading-snug">{t}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions Footer */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setMode('search');
                    setQuery(analysisResult.topic);
                    void run('search');
                  }}
                  className="rounded-md bg-accent px-4 py-2.5 text-xs font-semibold text-accent-foreground hover:bg-accent-hover transition-micro"
                >
                  Cari Video Terkait untuk Diimpor
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnalysisResult(null);
                    setTrendInput('');
                    setUserScript('');
                    setOptimizationResult(null);
                  }}
                  className="rounded-md border border-border px-4 py-2.5 text-xs font-medium text-text-primary hover:bg-accent/5 transition-micro"
                >
                  Mulai Analisis Baru
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
