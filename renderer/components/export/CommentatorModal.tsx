'use client';

/**
 * CommentatorModal — AI Video Commentator setup modal.
 * Allows user to generate viral commentary for videos using Gemini Multimodal vision,
 * select Google Speech / Gemini / EdgeTTS voices, and customize subtitle caption styles.
 */

import { useState, useEffect } from 'react';
import { ipc } from '../../lib/ipc-client';
import type { CaptionPresetId, CaptionStyle, CaptionFont, SubtitlePosition, CommentatorVoiceProvider, CommentatorTransitionEffect } from '../../../shared/types';
import { CAPTION_PRESETS } from '../../../shared/types';
import { cn } from '../../lib/utils';

interface CommentatorModalProps {
  videoPath: string;
  clipId?: string;
  projectId?: string;
  initialPresetId?: CaptionPresetId;
  initialCaptionStyle?: CaptionStyle;
  optionsJson?: string | null;
  onClose: () => void;
  onSuccess?: (outputPath: string, scriptText: string, hookText: string) => void;
}

const VOICE_OPTIONS = [
  { id: 'xtts-colab-custom',      name: '★ My Cloned Voice (Google Colab XTTS v2)', provider: 'Google Colab', badge: 'AI Clone' },
  { id: 'google-en-US-Journey-F', name: 'Google Journey Female (US - Recommended)', provider: 'Google Speech', badge: 'Viral US' },
  { id: 'google-en-US-Journey-D', name: 'Google Journey Male (US - Recommended)', provider: 'Google Speech', badge: 'Viral US' },
  { id: 'google-en-US-Journey-O', name: 'Google Journey Female Conversational', provider: 'Google Speech', badge: 'US' },
  { id: 'google-en-US-Studio-O',  name: 'Google Studio Female Premium', provider: 'Google Speech', badge: 'Studio' },
  { id: 'google-en-US-Studio-Q',  name: 'Google Studio Male Premium', provider: 'Google Speech', badge: 'Studio' },
  { id: 'gemini-Puck',            name: 'Gemini Voice (Puck - Energetic Male)', provider: 'Gemini', badge: 'Native' },
  { id: 'gemini-Kore',            name: 'Gemini Voice (Kore - Natural Female)', provider: 'Gemini', badge: 'Native' },
  { id: 'en-US-GuyNeural',        name: 'EdgeTTS Guy Male', provider: 'EdgeTTS (Free)', badge: 'Free' },
  { id: 'en-US-JennyNeural',      name: 'EdgeTTS Jenny Female', provider: 'EdgeTTS (Free)', badge: 'Free' },
  { id: 'google-id-ID-Neural2-B', name: 'Google Neural Ardi (Male ID)', provider: 'Google Speech', badge: 'ID' },
  { id: 'google-id-ID-Neural2-A', name: 'Google Neural Gadis (Female ID)', provider: 'Google Speech', badge: 'ID' },
];

const PRESET_OPTIONS: Array<{ id: CaptionPresetId; name: string; desc: string }> = [
  { id: 'tiktok',     name: 'TikTok Pop',  desc: 'Lilita One bold pop' },
  { id: 'hormozi',    name: 'Alex Hormozi', desc: 'Bold uppercase center impact' },
  { id: 'karaoke',    name: 'Karaoke',     desc: 'Word-by-word highlight' },
  { id: 'bangers',    name: 'Bangers Out', desc: 'Comic style heavy border' },
  { id: 'reels',      name: 'Reels',       desc: 'Multi-line cyan accent' },
  { id: 'thinkmedia', name: 'ThinkMedia',  desc: 'Yellow bold uppercase' },
  { id: 'simple',     name: 'Simple',      desc: 'Clean white text' },
  { id: 'none',       name: 'None',        desc: 'Hidden / No captions' },
  { id: 'custom',     name: 'Custom',      desc: 'Your own settings' },
];

const FONT_OPTIONS: CaptionFont[] = ['Montserrat', 'Impact', 'Oswald', 'Arial', 'Roboto', 'Anton', 'Lilita One', 'Bangers', 'Bebas Neue', 'Fredoka One'];

export function CommentatorModal({ videoPath, clipId, projectId, initialPresetId, initialCaptionStyle, optionsJson, onClose, onSuccess }: CommentatorModalProps) {
  const [targetAudience, setTargetAudience] = useState<'US' | 'UK' | 'ID'>('US');
  const [selectedVoice, setSelectedVoice] = useState<string>('google-en-US-Journey-F');
  
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(() => {
    // 1. Try optionsJson from clip database record
    if (optionsJson) {
      try {
        const parsed = JSON.parse(optionsJson);
        if (parsed?.captionStyle && parsed.captionStyle.font) return parsed.captionStyle;
        if (parsed?.caption && parsed.caption.font) return parsed.caption;
      } catch (e) {}
    }
    // 2. Try initialCaptionStyle prop
    if (initialCaptionStyle && initialCaptionStyle.font) {
      return initialCaptionStyle;
    }
    // 3. Try saved commentator-caption-settings from localStorage
    try {
      const savedCommentator = localStorage.getItem('commentator-caption-settings');
      if (savedCommentator) {
        const parsed = JSON.parse(savedCommentator);
        if (parsed?.captionStyle && parsed.captionStyle.font) return parsed.captionStyle;
        if (parsed?.caption && parsed.caption.font) return parsed.caption;
      }
    } catch (e) {}
    // 4. Try saved clip-preview-settings from localStorage
    try {
      const saved = localStorage.getItem('clip-preview-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.caption && parsed.caption.font) return parsed.caption;
      }
    } catch (e) {}
    // 5. Fallback to preset base
    let initId: CaptionPresetId = initialPresetId || 'tiktok';
    const base = CAPTION_PRESETS[initId] || CAPTION_PRESETS['tiktok'];
    return { ...base, presetId: initId };
  });

  const [captionY, setCaptionY] = useState<number | null>(() => {
    if (captionStyle.captionY !== undefined) return captionStyle.captionY;
    if (optionsJson) {
      try {
        const parsed = JSON.parse(optionsJson);
        if (parsed?.captionY !== undefined) return parsed.captionY;
      } catch (e) {}
    }
    return null;
  });

  const [duckingVolume, setDuckingVolume] = useState<number>(0.2);
  const [commentaryMode, setCommentaryMode] = useState<'full' | 'hook_only' | 'hook_replay_outro'>('full');
  const [transitionEffect, setTransitionEffect] = useState<CommentatorTransitionEffect>('fade');
  const [transitionSfx, setTransitionSfx] = useState<string>('whoosh');
  const [bgMusicPath, setBgMusicPath] = useState<string>('');
  const [bgMusicVolume, setBgMusicVolume] = useState<number>(0.20);
  const [customThumbnailPath, setCustomThumbnailPath] = useState<string>('');
  const [brandingLogoPath, setBrandingLogoPath] = useState<string>('');
  const [speakerAudioPath, setSpeakerAudioPath] = useState<string>('');

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [progressPct, setProgressPct] = useState<number>(0);

  const [targetPct, setTargetPct] = useState<number>(0);

  useEffect(() => {
    ipc.settings.get().then((s: any) => {
      if (s?.speakerAudioPath) setSpeakerAudioPath(s.speakerAudioPath);
    }).catch(() => {});

    const unsub = ipc.commentator.onProgress((data: any) => {
      if (typeof data?.percent === 'number') {
        setTargetPct(Math.min(100, Math.max(0, data.percent)));
      }
      if (data?.message) {
        setProgressMsg(data.message);
      }
    });
    return () => unsub();
  }, []);

  // Smooth continuous progress ticker so progress bar NEVER freezes during long operations
  useEffect(() => {
    if (!loading) {
      setProgressPct(0);
      setTargetPct(0);
      return;
    }

    // Set initial 5% immediately when loading starts
    setProgressPct((prev) => (prev === 0 ? 5 : prev));

    const interval = setInterval(() => {
      setProgressPct((prev) => {
        if (targetPct === 100) return 100;
        // Accelerate if behind targetPct
        if (prev < targetPct) {
          return Math.min(100, prev + 2);
        }
        // Continuous smooth creep forward (1% every 350ms) up to 98% while waiting for async tasks
        if (prev < 98) {
          return prev + 1;
        }
        return prev;
      });
    }, 350);

    return () => clearInterval(interval);
  }, [loading, targetPct]);

  // Auto-persist caption settings changes to localStorage
  useEffect(() => {
    try {
      const toSave = {
        presetId: captionStyle.presetId,
        captionStyle: {
          ...captionStyle,
          captionY: captionY ?? captionStyle.captionY,
        },
      };
      localStorage.setItem('commentator-caption-settings', JSON.stringify(toSave));
    } catch (e) {}
  }, [captionStyle, captionY]);

  const applyPreset = (id: CaptionPresetId) => {
    if (id === 'custom') {
      setCaptionStyle((prev) => ({ ...prev, presetId: 'custom' }));
    } else {
      const base = CAPTION_PRESETS[id] || CAPTION_PRESETS['tiktok'];
      setCaptionStyle({ ...base, presetId: id });
      setCaptionY(null);
    }
  };

  const updateCaptionStyle = (patch: Partial<CaptionStyle>) => {
    setCaptionStyle((prev) => ({
      ...prev,
      ...patch,
      presetId: 'custom',
    }));
  };

  const changeCaptionY = (y: number | null) => {
    setCaptionY(y);
    if (y !== null) {
      updateCaptionStyle({ captionY: y });
    }
  };

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setProgressPct(5);
    setTargetPct(5);
    setProgressMsg('Uploading video to Vertex Gemini & generating viral commentary script...');

    try {
      const voiceObj = VOICE_OPTIONS.find(v => v.id === selectedVoice);
      let provider: CommentatorVoiceProvider = 'google-tts';
      if (voiceObj?.provider === 'Gemini') provider = 'gemini-audio';
      else if (voiceObj?.provider === 'EdgeTTS (Free)') provider = 'edge-tts';

      const finalStyle: CaptionStyle = {
        ...captionStyle,
        captionY: captionY ?? captionStyle.captionY,
      };

      const result = await ipc.commentator.generate({
        clipId,
        videoPath,
        projectId,
        voiceProvider: provider,
        voiceId: selectedVoice,
        captionPresetId: finalStyle.presetId,
        captionStyle: finalStyle,
        targetAudience,
        duckingVolume,
        commentaryMode,
        transitionEffect,
        transitionSfx,
        bgMusicPath: bgMusicPath || undefined,
        bgMusicVolume,
        customThumbnailPath: customThumbnailPath || undefined,
        brandingLogoPath: brandingLogoPath || undefined,
        speakerAudioPath: speakerAudioPath || undefined,
      }) as any;

      if (result && result.outputPath) {
        if (onSuccess) {
          onSuccess(result.outputPath, result.scriptText, result.hookText);
        }
        onClose();
      } else {
        throw new Error('Failed to generate commentary video output.');
      }
    } catch (err: any) {
      setError(err?.message || 'An error occurred while generating commentary.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-surface/95 p-6 shadow-2xl backdrop-blur-xl my-8 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10 sticky top-0 bg-surface/95 z-10 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-white shadow-lg shadow-indigo-500/25">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-text-primary">Video Commentator</h2>
              <p className="text-xs text-text-secondary">Analyze video visuals via Gemini Multimodal & generate viral commentary voiceover</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-secondary hover:bg-white/5 hover:text-text-primary transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form Controls */}
        <div className="mt-5 space-y-5">
          {/* Commentary Mode Selection */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-2">
              Commentary Mode
            </label>
            <div className="grid grid-cols-3 gap-3">
              {[
                { id: 'full', label: 'Full Commentary', desc: 'Dubbing & subtitles span the full video duration' },
                { id: 'hook_only', label: 'Hook + Replay', desc: '3s Hook intro + BGM, then raw clip replays' },
                { id: 'hook_replay_outro', label: 'Hook + Replay + Moral Takeaway', desc: '3s Hook intro + raw clip + educational moral lesson takeaway outro (100% Monetizable)' },
              ].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setCommentaryMode(m.id as any)}
                  className={cn(
                    'flex flex-col items-start rounded-xl border p-3 text-left transition-all',
                    commentaryMode === m.id
                      ? 'border-indigo-500/80 bg-indigo-500/10 ring-2 ring-indigo-500/30'
                      : 'border-white/10 bg-surface-elevated/40 hover:bg-white/5'
                  )}
                >
                  <span className="text-sm font-semibold text-text-primary">{m.label}</span>
                  <span className="text-xs text-text-secondary mt-0.5">{m.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Transition Effect Selection (when commentaryMode !== 'full') */}
          {(commentaryMode === 'hook_only' || commentaryMode === 'hook_replay_outro') && (
            <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 space-y-3 animate-fade-in">
              <label className="block text-xs font-semibold uppercase tracking-wider text-indigo-300">
                Segment 1 to Segment 2 Transition Effect (100% Anti-Reused Content)
              </label>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { id: 'fade', label: 'Crossfade', badge: 'Recommended' },
                  { id: 'slideleft', label: 'Push Left', badge: 'Viral' },
                  { id: 'slideright', label: 'Push Right', badge: 'Viral' },
                  { id: 'wipeleft', label: 'Wipe Sweep', badge: 'Clean' },
                  { id: 'pixelize', label: 'Pixel Glitch', badge: 'Retro' },
                  { id: 'zoomin', label: 'Zoom Flash', badge: 'Energy' },
                  { id: 'none', label: 'Direct Cut', badge: 'Fast' },
                ].map((tr) => (
                  <button
                    key={tr.id}
                    type="button"
                    onClick={() => setTransitionEffect(tr.id as any)}
                    className={cn(
                      'flex flex-col items-center justify-center rounded-xl border p-2 text-center transition-all',
                      transitionEffect === tr.id
                        ? 'border-indigo-500/80 bg-indigo-500/20 ring-2 ring-indigo-500/40 text-white font-semibold'
                        : 'border-white/10 bg-surface-elevated/40 hover:bg-white/5 text-text-secondary'
                    )}
                  >
                    <span className="text-xs">{tr.label}</span>
                    <span className="text-[9px] text-text-muted mt-0.5">{tr.badge}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Transition Sound Effect (SFX) Selection */}
          {(commentaryMode === 'hook_only' || commentaryMode === 'hook_replay_outro') && transitionEffect !== 'none' && (
            <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-4 space-y-3 animate-fade-in">
              <label className="block text-xs font-semibold uppercase tracking-wider text-purple-300">
                Transition Sound Effect (SFX)
              </label>
              <div className="grid grid-cols-5 gap-2">
                {[
                  { id: 'whoosh', label: 'Whoosh', desc: 'Fast Cinematic' },
                  { id: 'swoosh', label: 'Swoosh', desc: 'Deep Sweep' },
                  { id: 'glitch', label: 'Glitch', desc: 'Cyber Pop' },
                  { id: 'custom', label: 'Custom File', desc: 'Upload Audio' },
                  { id: 'none', label: 'Mute SFX', desc: 'No Sound' },
                ].map((sfx) => {
                  const isSelected =
                    sfx.id === 'custom'
                      ? transitionSfx !== 'whoosh' && transitionSfx !== 'swoosh' && transitionSfx !== 'glitch' && transitionSfx !== 'none'
                      : transitionSfx === sfx.id;
                  return (
                    <button
                      key={sfx.id}
                      type="button"
                      onClick={async () => {
                        if (sfx.id === 'custom') {
                          try {
                            const file = await ipc.dialog.openFile();
                            if (file) setTransitionSfx(file);
                          } catch (e) {}
                        } else {
                          setTransitionSfx(sfx.id);
                        }
                      }}
                      className={cn(
                        'flex flex-col items-center justify-center rounded-xl border p-2 text-center transition-all',
                        isSelected
                          ? 'border-purple-500/80 bg-purple-500/20 ring-2 ring-purple-500/40 text-white font-semibold'
                          : 'border-white/10 bg-surface-elevated/40 hover:bg-white/5 text-text-secondary'
                      )}
                    >
                      <span className="text-xs">{sfx.label}</span>
                      <span className="text-[9px] text-text-muted mt-0.5">{sfx.desc}</span>
                    </button>
                  );
                })}
              </div>
              {transitionSfx !== 'whoosh' && transitionSfx !== 'swoosh' && transitionSfx !== 'glitch' && transitionSfx !== 'none' && (
                <div className="text-[11px] text-purple-300 font-mono truncate pt-1">
                  Selected SFX: {transitionSfx.split(/[/\\]/).pop()}
                </div>
              )}
            </div>
          )}

          {/* Background Music & Volume */}
          {(commentaryMode === 'hook_only' || commentaryMode === 'hook_replay_outro') && (
            <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 space-y-3 animate-fade-in">
              <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary">
                Hook Background Music (BGM)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  readOnly
                  placeholder="No background music selected (Optional)"
                  value={bgMusicPath ? bgMusicPath.split(/[/\\]/).pop() || bgMusicPath : ''}
                  className="flex-1 rounded-lg border border-white/10 bg-surface-elevated px-3 py-2 text-xs text-text-primary focus:outline-none"
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const file = await ipc.dialog.openFile();
                      if (file) setBgMusicPath(file);
                    } catch (e) {}
                  }}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
                >
                  Choose Audio File
                </button>
                {bgMusicPath && (
                  <button
                    type="button"
                    onClick={() => setBgMusicPath('')}
                    className="rounded-lg bg-red-500/20 px-2.5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/30 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-text-secondary font-medium">BGM Volume</span>
                  <span className="text-text-primary font-bold">{Math.round(bgMusicVolume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={bgMusicVolume}
                  onChange={(e) => setBgMusicVolume(parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>

              {/* Custom Thumbnail Overlay */}
              <div className="pt-2 border-t border-white/10">
                <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1">
                  Custom Opening Thumbnail (Optional Muted Frame)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    readOnly
                    placeholder="No custom thumbnail image (Optional)"
                    value={customThumbnailPath ? customThumbnailPath.split(/[/\\]/).pop() || customThumbnailPath : ''}
                    className="flex-1 rounded-lg border border-white/10 bg-surface-elevated px-3 py-2 text-xs text-text-primary focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const file = await ipc.dialog.openFile();
                        if (file) setCustomThumbnailPath(file);
                      } catch (e) {}
                    }}
                    className="rounded-lg bg-purple-600 px-3 py-2 text-xs font-medium text-white hover:bg-purple-500 transition-colors"
                  >
                    Choose Image
                  </button>
                  {customThumbnailPath && (
                    <button
                      type="button"
                      onClick={() => setCustomThumbnailPath('')}
                      className="rounded-lg bg-red-500/20 px-2.5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/30 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Branding Logo Watermark */}
              <div className="pt-2 border-t border-white/10">
                <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1">
                  Branding Logo Watermark (Semi-Transparent Overlay)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    readOnly
                    placeholder="No branding logo (Optional)"
                    value={brandingLogoPath ? brandingLogoPath.split(/[/\\]/).pop() || brandingLogoPath : ''}
                    className="flex-1 rounded-lg border border-white/10 bg-surface-elevated px-3 py-2 text-xs text-text-primary focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const file = await ipc.dialog.openFile();
                        if (file) setBrandingLogoPath(file);
                      } catch (e) {}
                    }}
                    className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500 transition-colors"
                  >
                    Choose Logo
                  </button>
                  {brandingLogoPath && (
                    <button
                      type="button"
                      onClick={() => setBrandingLogoPath('')}
                      className="rounded-lg bg-red-500/20 px-2.5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/30 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Target Audience */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-2">
              Target Audience & Hook Style
            </label>
            <div className="grid grid-cols-3 gap-3">
              {[
                { id: 'US', label: 'US Audience', desc: 'High energy 1-3s hook' },
                { id: 'UK', label: 'UK Audience', desc: 'Witty & sharp British tone' },
                { id: 'ID', label: 'Indonesian', desc: 'Viral Gen-Z Shorts style' },
              ].map((aud) => (
                <button
                  key={aud.id}
                  type="button"
                  onClick={() => setTargetAudience(aud.id as any)}
                  className={cn(
                    'flex flex-col items-start rounded-xl border p-3 text-left transition-all',
                    targetAudience === aud.id
                      ? 'border-indigo-500/80 bg-indigo-500/10 ring-2 ring-indigo-500/30'
                      : 'border-white/10 bg-surface-elevated/40 hover:bg-white/5'
                  )}
                >
                  <span className="text-sm font-semibold text-text-primary">{aud.label}</span>
                  <span className="text-xs text-text-secondary mt-0.5">{aud.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Voice Selection */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-2">
              Commentator Voice Dubber
            </label>
            <div className="relative">
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-surface-elevated px-4 py-2.5 text-sm text-text-primary focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              >
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} [{v.badge}]
                  </option>
                ))}
              </select>
            </div>

            {selectedVoice === 'xtts-colab-custom' && (
              <div className="mt-3 p-3.5 rounded-xl border border-indigo-500/40 bg-indigo-500/10">
                <label className="block text-xs font-semibold uppercase tracking-wider text-indigo-300 mb-1.5">
                  Reference Voice Sample (.mp3 / .wav)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    readOnly
                    placeholder="Upload a 15–30s recording of your voice"
                    value={speakerAudioPath ? speakerAudioPath.split(/[/\\]/).pop() || speakerAudioPath : ''}
                    className="flex-1 rounded-lg border border-white/10 bg-surface-elevated px-3 py-2 text-xs text-text-primary focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const file = await ipc.dialog.openFile();
                        if (file) {
                          setSpeakerAudioPath(file);
                          ipc.settings.set({ speakerAudioPath: file }).catch(() => {});
                        }
                      } catch (e) {}
                    }}
                    className="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors shadow-sm"
                  >
                    {speakerAudioPath ? 'Change Sample' : 'Upload Voice Sample'}
                  </button>
                  {speakerAudioPath && (
                    <button
                      type="button"
                      onClick={() => {
                        setSpeakerAudioPath('');
                        ipc.settings.set({ speakerAudioPath: '' }).catch(() => {});
                      }}
                      className="rounded-lg bg-red-500/20 px-2.5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/30 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-indigo-200/80 mt-2 leading-relaxed">
                  <strong>Penting:</strong> Unggah sampel rekaman suara Anda (15–30 detik). AI Google Colab akan mengkloning warna suara, intonasi, dan aksen Anda untuk mengisi suara dubbing!
                </p>
              </div>
            )}
          </div>

          {/* Subtitle Style Preset */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-2">
              Subtitle Style Preset
            </label>
            <div className="grid grid-cols-3 gap-2.5">
              {PRESET_OPTIONS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset.id)}
                  className={cn(
                    'flex flex-col items-start rounded-xl border p-2.5 text-left transition-all',
                    captionStyle.presetId === preset.id
                      ? 'border-purple-500/80 bg-purple-500/10 ring-2 ring-purple-500/30'
                      : 'border-white/10 bg-surface-elevated/40 hover:bg-white/5'
                  )}
                >
                  <span className="text-xs font-bold text-text-primary">{preset.name}</span>
                  <span className="text-[10px] text-text-secondary mt-0.5 line-clamp-1">{preset.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Detailed Caption Controls (Matching Preview Panel 100%) */}
          <div className="rounded-xl border border-white/10 bg-surface-elevated/40 p-4 space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-400">
              Caption Style & Customization
            </h3>

            <div className="grid grid-cols-2 gap-4">
              {/* Font Family */}
              <div>
                <label className="block text-[11px] font-semibold text-text-secondary mb-1">
                  Font Family
                </label>
                <select
                  value={captionStyle.font}
                  onChange={(e) => updateCaptionStyle({ font: e.target.value as CaptionFont })}
                  className="w-full rounded-lg border border-white/10 bg-surface-elevated px-3 py-1.5 text-xs text-text-primary focus:border-indigo-500 focus:outline-none"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>

              {/* Font Size */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[11px] font-semibold text-text-secondary">
                    Font Size
                  </label>
                  <span className="text-xs font-bold text-indigo-400">{captionStyle.fontSize}px</span>
                </div>
                <input
                  type="range"
                  min="40"
                  max="140"
                  step="5"
                  value={captionStyle.fontSize}
                  onChange={(e) => updateCaptionStyle({ fontSize: parseInt(e.target.value) })}
                  className="w-full h-1.5 rounded-lg bg-surface-elevated accent-indigo-500 cursor-pointer"
                />
              </div>

              {/* Position */}
              <div>
                <label className="block text-[11px] font-semibold text-text-secondary mb-1">
                  Position
                </label>
                <div className="flex gap-1 mb-1">
                  {[
                    { label: 'Top', y: 170 },
                    { label: 'Mid', y: 960 },
                    { label: 'Bot', y: 1750 },
                  ].map(({ label, y }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => changeCaptionY(y)}
                      className={cn(
                        'flex-1 rounded-lg border px-2 py-1 text-[10px] font-semibold transition-all',
                        captionY === y || (!captionY && ((y === 1750 && captionStyle.position === 'lower-third') || (y === 170 && captionStyle.position === 'upper-third') || (y === 960 && captionStyle.position === 'center')))
                          ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200'
                          : 'border-white/10 bg-surface-elevated text-text-secondary hover:text-text-primary'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="range"
                    min={50} max={1900}
                    value={captionY ?? (captionStyle.position === 'lower-third' ? 1750 : captionStyle.position === 'upper-third' ? 170 : 960)}
                    onChange={(e) => changeCaptionY(Number(e.target.value))}
                    className="w-full h-1 rounded-lg bg-surface-elevated accent-indigo-500 cursor-pointer"
                  />
                  <span className="w-8 text-right text-[10px] font-mono text-text-secondary">
                    {captionY ?? (captionStyle.position === 'lower-third' ? 1750 : captionStyle.position === 'upper-third' ? 170 : 960)}
                  </span>
                </div>
              </div>

              {/* Animation & Words/Line */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-text-secondary mb-1">
                    Animation
                  </label>
                  <select
                    value={captionStyle.animation}
                    onChange={(e) => updateCaptionStyle({ animation: e.target.value as any })}
                    className="w-full rounded-lg border border-white/10 bg-surface-elevated px-2.5 py-1 text-xs text-text-primary focus:border-indigo-500"
                  >
                    <option value="none">None</option>
                    <option value="fade">Fade</option>
                    <option value="pop">Pop</option>
                    <option value="slide-up">Slide Up</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-text-secondary mb-1">
                    Words/Line
                  </label>
                  <select
                    value={captionStyle.lines}
                    onChange={(e) => updateCaptionStyle({ lines: Number(e.target.value) as any })}
                    className="w-full rounded-lg border border-white/10 bg-surface-elevated px-2.5 py-1 text-xs text-text-primary focus:border-indigo-500"
                  >
                    <option value={1}>1 word</option>
                    <option value={2}>2 words</option>
                    <option value={3}>3 words</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Color Swatches */}
            <div className="grid grid-cols-3 gap-3 pt-1">
              {/* Primary Color */}
              <div>
                <label className="block text-[11px] font-semibold text-text-secondary mb-1">
                  Text Color
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={captionStyle.primaryColor.startsWith('#') ? captionStyle.primaryColor : '#FFFFFF'}
                    onChange={(e) => updateCaptionStyle({ primaryColor: e.target.value })}
                    className="h-6 w-8 rounded border border-white/10 bg-transparent p-0.5 cursor-pointer"
                  />
                  <div className="flex gap-1">
                    {['#FFFF00', '#FFFFFF', '#00FF00', '#FF0055'].map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => updateCaptionStyle({ primaryColor: c })}
                        style={{ backgroundColor: c }}
                        className={cn(
                          'h-4 w-4 rounded-full border border-black/40 transition-transform hover:scale-110',
                          captionStyle.primaryColor.toLowerCase() === c.toLowerCase() && 'ring-2 ring-indigo-400 ring-offset-1 ring-offset-black'
                        )}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Highlight Color */}
              <div>
                <label className="block text-[11px] font-semibold text-text-secondary mb-1">
                  Highlight Color
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={captionStyle.highlightColor.startsWith('#') ? captionStyle.highlightColor : '#FFFF00'}
                    onChange={(e) => updateCaptionStyle({ highlightColor: e.target.value })}
                    className="h-6 w-8 rounded border border-white/10 bg-transparent p-0.5 cursor-pointer"
                  />
                  <div className="flex gap-1">
                    {['#FFFF00', '#00FF00', '#00E5FF', '#FF0055'].map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => updateCaptionStyle({ highlightColor: c })}
                        style={{ backgroundColor: c }}
                        className={cn(
                          'h-4 w-4 rounded-full border border-black/40 transition-transform hover:scale-110',
                          captionStyle.highlightColor.toLowerCase() === c.toLowerCase() && 'ring-2 ring-indigo-400 ring-offset-1 ring-offset-black'
                        )}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Outline Color */}
              <div>
                <label className="block text-[11px] font-semibold text-text-secondary mb-1">
                  Outline Color
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={captionStyle.outlineColor.startsWith('#') ? captionStyle.outlineColor : '#000000'}
                    onChange={(e) => updateCaptionStyle({ outlineColor: e.target.value })}
                    className="h-6 w-8 rounded border border-white/10 bg-transparent p-0.5 cursor-pointer"
                  />
                  <div className="flex gap-1">
                    {['#000000', '#111111', '#FFFFFF', '#220033'].map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => updateCaptionStyle({ outlineColor: c })}
                        style={{ backgroundColor: c }}
                        className={cn(
                          'h-4 w-4 rounded-full border border-black/40 transition-transform hover:scale-110',
                          captionStyle.outlineColor.toLowerCase() === c.toLowerCase() && 'ring-2 ring-indigo-400 ring-offset-1 ring-offset-black'
                        )}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Outline Size & Shadow Size */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[11px] font-semibold text-text-secondary">
                    Outline ({captionStyle.outlineSize}px)
                  </label>
                </div>
                <input
                  type="range"
                  min="0" max="12" step="1"
                  value={captionStyle.outlineSize}
                  onChange={(e) => updateCaptionStyle({ outlineSize: parseInt(e.target.value) })}
                  className="w-full h-1.5 rounded-lg bg-surface-elevated accent-indigo-500 cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[11px] font-semibold text-text-secondary">
                    Shadow ({captionStyle.shadowSize}px)
                  </label>
                </div>
                <input
                  type="range"
                  min="0" max="8" step="1"
                  value={captionStyle.shadowSize}
                  onChange={(e) => updateCaptionStyle({ shadowSize: parseInt(e.target.value) })}
                  className="w-full h-1.5 rounded-lg bg-surface-elevated accent-indigo-500 cursor-pointer"
                />
              </div>
            </div>

            {/* Switches */}
            <div className="grid grid-cols-3 gap-2 pt-1 border-t border-white/5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-text-secondary font-semibold">Uppercase</span>
                <button
                  type="button"
                  onClick={() => updateCaptionStyle({ uppercase: !captionStyle.uppercase })}
                  className={cn(
                    'relative h-3.5 w-7 rounded-full border transition-all',
                    captionStyle.uppercase ? 'border-indigo-500 bg-indigo-500' : 'border-white/20 bg-surface-elevated'
                  )}
                >
                  <span className={cn('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all', captionStyle.uppercase ? 'left-3.5' : 'left-0.5')} />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[10px] text-text-secondary font-semibold">Shake Effect</span>
                <button
                  type="button"
                  onClick={() => updateCaptionStyle({ shakeEffect: !(captionStyle.shakeEffect ?? true) })}
                  className={cn(
                    'relative h-3.5 w-7 rounded-full border transition-all',
                    (captionStyle.shakeEffect ?? true) ? 'border-indigo-500 bg-indigo-500' : 'border-white/20 bg-surface-elevated'
                  )}
                >
                  <span className={cn('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all', (captionStyle.shakeEffect ?? true) ? 'left-3.5' : 'left-0.5')} />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[10px] text-text-secondary font-semibold">Karaoke Sweep</span>
                <button
                  type="button"
                  onClick={() => updateCaptionStyle({ karaokeHighlight: !(captionStyle.karaokeHighlight ?? false) })}
                  className={cn(
                    'relative h-3.5 w-7 rounded-full border transition-all',
                    (captionStyle.karaokeHighlight ?? false) ? 'border-indigo-500 bg-indigo-500' : 'border-white/20 bg-surface-elevated'
                  )}
                >
                  <span className={cn('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all', (captionStyle.karaokeHighlight ?? false) ? 'left-3.5' : 'left-0.5')} />
                </button>
              </div>
            </div>
          </div>

          {/* Background Volume Ducking */}
          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                Original Background Video Volume
              </label>
              <span className="text-xs font-bold text-indigo-400">{Math.round(duckingVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={duckingVolume}
              onChange={(e) => setDuckingVolume(parseFloat(e.target.value))}
              className="w-full h-2 rounded-lg bg-surface-elevated accent-indigo-500 cursor-pointer"
            />
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
            {error}
          </div>
        )}

        {/* Realtime Progress Bar & Stage Indicator */}
        {loading && (
          <div className="mt-5 rounded-2xl border border-indigo-500/40 bg-gradient-to-b from-indigo-950/40 to-slate-900/60 p-4 space-y-3 shadow-xl animate-fade-in">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent flex-shrink-0" />
                <span className="text-xs font-semibold text-indigo-200 truncate max-w-[340px]">
                  {progressMsg || 'Generating AI Commentary Video...'}
                </span>
              </div>
              <span className="text-xs font-bold font-mono text-indigo-300 bg-indigo-500/20 px-2.5 py-0.5 rounded-md border border-indigo-500/30 shadow-sm">
                {progressPct}%
              </span>
            </div>

            {/* Glowing Gradient Progress Bar */}
            <div className="h-3 w-full rounded-full bg-slate-950/80 p-0.5 border border-white/10 overflow-hidden relative shadow-inner">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 transition-all duration-300 ease-out shadow-[0_0_12px_rgba(99,102,241,0.6)] relative"
                style={{ width: `${Math.max(5, progressPct)}%` }}
              >
                <div className="absolute inset-0 bg-white/20 animate-pulse" />
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-end gap-3 pt-4 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-xl px-4 py-2 text-xs font-semibold text-text-secondary hover:bg-white/5 hover:text-text-primary transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-600 hover:to-purple-700 transition-all disabled:opacity-50"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Generate Commentary Video
          </button>
        </div>
      </div>
    </div>
  );
}
