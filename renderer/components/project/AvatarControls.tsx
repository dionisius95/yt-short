'use client';

/**
 * AvatarControls — UI for the optional Talking Avatar overlay on Commentary
 * videos (3-segment / hook_replay_outro mode).
 *
 * Fully additive: when `value.enabled` is false (the default) the parent must
 * ignore the rest of the overlay config and keep the existing commentary
 * pipeline output unchanged.
 */

import { useCallback, useRef, useState } from 'react';
import { ipc } from '../../lib/ipc-client';
import { cn } from '../../lib/utils';
import {
  DEFAULT_AVATAR_OVERLAY,
  type AvatarOverlay,
  type AvatarPosition,
  type AvatarShape,
} from '../../../shared/avatarTypes';

// Canvas is a 1080x1920 vertical Short. Keep these in sync with the compositor.
const CANVAS_W = 1080;
const CANVAS_H = 1920;

const POSITION_OPTS: { value: AvatarPosition; label: string }[] = [
  { value: 'top-left', label: '\u2196 Kiri Atas' },
  { value: 'top-right', label: '\u2197 Kanan Atas' },
  { value: 'bottom-left', label: '\u2199 Kiri Bawah' },
  { value: 'bottom-right', label: '\u2198 Kanan Bawah' },
  { value: 'center', label: '\u25CF Tengah' },
];

const SHAPE_OPTS: { value: AvatarShape; label: string }[] = [
  { value: 'circle', label: 'Bulat' },
  { value: 'rect', label: 'Kotak' },
];

interface AvatarControlsProps {
  value?: AvatarOverlay;
  onChange: (next: AvatarOverlay) => void;
}

/** Avatar box size in canvas px (square for both circle & talk/idle clips). */
function avatarBox(overlay: AvatarOverlay): { w: number; h: number } {
  const w = Math.max(2, Math.round(CANVAS_W * overlay.scale));
  return { w, h: w };
}

/**
 * Resolve the avatar top-left corner in canvas px from either the manual
 * x/y override (wins when both are numbers) or the named preset + margin.
 * MUST mirror AvatarCompositor.position() so the preview matches the render.
 */
function resolveXY(overlay: AvatarOverlay): { x: number; y: number } {
  const { w, h } = avatarBox(overlay);
  const m = overlay.margin ?? 48;
  if (typeof overlay.x === 'number' && typeof overlay.y === 'number') {
    return { x: overlay.x, y: overlay.y };
  }
  switch (overlay.position) {
    case 'top-left':
      return { x: m, y: m };
    case 'top-right':
      return { x: CANVAS_W - w - m, y: m };
    case 'bottom-left':
      return { x: m, y: CANVAS_H - h - m };
    case 'bottom-right':
      return { x: CANVAS_W - w - m, y: CANVAS_H - h - m };
    case 'center':
      return { x: (CANVAS_W - w) / 2, y: (CANVAS_H - h) / 2 };
    default:
      return { x: CANVAS_W - w - m, y: m };
  }
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export function AvatarControls({ value, onChange }: AvatarControlsProps) {
  const overlay: AvatarOverlay = { ...DEFAULT_AVATAR_OVERLAY, ...(value ?? {}) };
  const isManual =
    typeof overlay.x === 'number' && typeof overlay.y === 'number';

  const patch = (partial: Partial<AvatarOverlay>) =>
    onChange({ ...overlay, ...partial });

  const { w: boxW, h: boxH } = avatarBox(overlay);
  const { x: curX, y: curY } = resolveXY(overlay);
  const maxX = Math.max(0, CANVAS_W - boxW);
  const maxY = Math.max(0, CANVAS_H - boxH);

  const previewRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imgOk, setImgOk] = useState(true);

  const handlePickImage = async () => {
    try {
      const file = await ipc.dialog.openFile();
      if (file) {
        setImgOk(true);
        patch({ imagePath: file });
      }
    } catch {
      /* cancelled */
    }
  };

  // Switch to a named preset: drop the manual x/y so the preset math applies.
  const selectPreset = (position: AvatarPosition) =>
    patch({ position, x: undefined, y: undefined });

  // Set an absolute X (keeps the current preset as a fallback label only).
  const setManualX = (x: number) =>
    patch({ x: clamp(Math.round(x), 0, maxX), y: isManual ? overlay.y : curY });
  const setManualY = (y: number) =>
    patch({ y: clamp(Math.round(y), 0, maxY), x: isManual ? overlay.x : curX });

  // Drag the avatar box inside the preview to set X/Y directly.
  const applyPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = previewRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const sx = CANVAS_W / rect.width;
      const sy = CANVAS_H / rect.height;
      // Center the box on the cursor, then convert to top-left canvas coords.
      const cxCanvas = (clientX - rect.left) * sx;
      const cyCanvas = (clientY - rect.top) * sy;
      patch({
        x: clamp(Math.round(cxCanvas - boxW / 2), 0, maxX),
        y: clamp(Math.round(cyCanvas - boxH / 2), 0, maxY),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boxW, boxH, maxX, maxY],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
    applyPointer(e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    applyPointer(e.clientX, e.clientY);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // Preview geometry in %, so it scales with whatever pixel size we render.
  const pctLeft = (curX / CANVAS_W) * 100;
  const pctTop = (curY / CANVAS_H) * 100;
  const pctW = (boxW / CANVAS_W) * 100;
  const pctH = (boxH / CANVAS_H) * 100;
  const fileUrl = overlay.imagePath
    ? `file://${overlay.imagePath.replace(/\\/g, '/')}`
    : '';

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-surface-elevated/40 p-4">
      {/* Toggle */}
      <label htmlFor="avatar-enabled" className="flex items-start gap-3 cursor-pointer">
        <input
          id="avatar-enabled"
          type="checkbox"
          checked={overlay.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-500"
        />
        <span className="text-sm text-text-primary">
          Aktifkan Talking Avatar (eksperimental)
          <span className="block text-[10px] text-text-secondary">
            Menambahkan avatar berbicara dari foto yang Anda unggah. Jika dimatikan, hasil commentary sama persis seperti sekarang.
          </span>
        </span>
      </label>

      {overlay.enabled && (
        <div className="flex flex-col gap-4 pl-7">
          {/* Image upload */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Foto Avatar</span>
            <div className="flex items-center gap-3">
              <input
                type="text"
                readOnly
                value={overlay.imagePath ? overlay.imagePath.split(/[/\\]/).pop() || overlay.imagePath : ''}
                placeholder="Belum ada foto dipilih"
                className="flex-1 rounded-lg border border-white/10 bg-surface-elevated px-3 py-2 text-xs text-text-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handlePickImage()}
                className="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors shadow-sm"
              >
                {overlay.imagePath ? 'Ganti Foto' : 'Pilih Foto'}
              </button>
              {overlay.imagePath && (
                <button
                  type="button"
                  onClick={() => patch({ imagePath: '' })}
                  className="rounded-lg bg-red-500/20 px-2.5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/30 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-[10px] text-text-secondary">
              Gunakan foto wajah menghadap depan (crop rapat ke wajah, pencahayaan merata) untuk hasil paling natural.
            </p>
          </div>

          {/* Position + live preview */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Posisi Avatar</span>
              <span className="text-[10px] text-text-secondary">
                {isManual ? 'Manual (X/Y)' : 'Preset'}
              </span>
            </div>

            <div className="flex gap-4">
              {/* Live 9:16 preview with a draggable avatar box */}
              <div
                ref={previewRef}
                onPointerMove={onPointerMove}
                className="relative shrink-0 overflow-hidden rounded-lg border border-white/15 bg-gradient-to-b from-slate-700/60 to-slate-900/80"
                style={{ width: 132, height: 234 }}
                title="Seret kotak avatar untuk mengatur posisi"
              >
                {/* thirds guides */}
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute left-1/3 top-0 h-full w-px bg-white/10" />
                  <div className="absolute left-2/3 top-0 h-full w-px bg-white/10" />
                  <div className="absolute top-1/3 left-0 w-full h-px bg-white/10" />
                  <div className="absolute top-2/3 left-0 w-full h-px bg-white/10" />
                </div>
                <div
                  onPointerDown={onPointerDown}
                  onPointerUp={onPointerUp}
                  className={cn(
                    'absolute flex items-center justify-center overflow-hidden border-2 text-[9px] font-semibold text-white/90 shadow-lg cursor-grab active:cursor-grabbing select-none',
                    dragging ? 'border-indigo-300' : 'border-indigo-400/90',
                    overlay.shape === 'circle' ? 'rounded-full' : 'rounded-md',
                  )}
                  style={{
                    left: `${pctLeft}%`,
                    top: `${pctTop}%`,
                    width: `${pctW}%`,
                    height: `${pctH}%`,
                    background: 'rgba(99,102,241,0.35)',
                    touchAction: 'none',
                  }}
                >
                  {fileUrl && imgOk ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={fileUrl}
                      alt="avatar"
                      draggable={false}
                      onError={() => setImgOk(false)}
                      className="h-full w-full object-cover pointer-events-none"
                    />
                  ) : (
                    <span>Avatar</span>
                  )}
                </div>
              </div>

              {/* Preset buttons + manual X/Y sliders */}
              <div className="flex flex-1 flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {POSITION_OPTS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => selectPreset(opt.value)}
                      className={cn(
                        'rounded-lg border px-3 py-1.5 text-xs font-medium transition-all',
                        !isManual && overlay.position === opt.value
                          ? 'border-indigo-500/80 bg-indigo-500/20 text-indigo-200 ring-2 ring-indigo-500/30'
                          : 'border-white/10 bg-surface-elevated/40 text-text-secondary hover:bg-white/5 hover:text-text-primary'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-surface-elevated/30 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Atur Posisi X / Y</span>
                    {isManual && (
                      <button
                        type="button"
                        onClick={() => patch({ x: undefined, y: undefined })}
                        className="rounded-md bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-white/10 hover:text-text-primary"
                      >
                        Kembali ke preset
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-4 text-[10px] font-bold text-indigo-400">X</span>
                    <input
                      type="range"
                      min={0}
                      max={maxX}
                      step={2}
                      value={Math.round(curX)}
                      onChange={(e) => setManualX(parseFloat(e.target.value))}
                      className="h-1.5 flex-1 rounded-lg bg-surface-elevated accent-indigo-500 cursor-pointer"
                    />
                    <span className="w-10 text-right text-[10px] tabular-nums text-text-secondary">{Math.round(curX)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-4 text-[10px] font-bold text-indigo-400">Y</span>
                    <input
                      type="range"
                      min={0}
                      max={maxY}
                      step={2}
                      value={Math.round(curY)}
                      onChange={(e) => setManualY(parseFloat(e.target.value))}
                      className="h-1.5 flex-1 rounded-lg bg-surface-elevated accent-indigo-500 cursor-pointer"
                    />
                    <span className="w-10 text-right text-[10px] tabular-nums text-text-secondary">{Math.round(curY)}</span>
                  </div>
                  <p className="text-[10px] text-text-secondary">
                    Koordinat piksel pada kanvas {CANVAS_W}×{CANVAS_H}. Seret kotak di preview atau geser slider; pilih preset untuk kembali otomatis.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Shape */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Bentuk</span>
            <div className="flex gap-2">
              {SHAPE_OPTS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patch({ shape: opt.value })}
                  className={cn(
                    'rounded-lg border px-4 py-1.5 text-xs font-medium transition-all',
                    overlay.shape === opt.value
                      ? 'border-indigo-500/80 bg-indigo-500/20 text-indigo-200 ring-2 ring-indigo-500/30'
                      : 'border-white/10 bg-surface-elevated/40 text-text-secondary hover:bg-white/5 hover:text-text-primary'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Scale */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Ukuran Avatar</span>
              <span className="text-xs font-bold text-indigo-400">{Math.round(overlay.scale * 100)}% lebar video</span>
            </div>
            <input
              type="range"
              min={0.12}
              max={0.5}
              step={0.02}
              value={overlay.scale}
              onChange={(e) => patch({ scale: parseFloat(e.target.value) })}
              className="w-full h-1.5 rounded-lg bg-surface-elevated accent-indigo-500 cursor-pointer"
            />
          </div>

          {/* Background removal toggle */}
          <label htmlFor="avatar-rmbg" className="flex items-start gap-3 cursor-pointer rounded-lg border border-white/10 bg-surface-elevated/30 p-3">
            <input
              id="avatar-rmbg"
              type="checkbox"
              checked={!!overlay.removeBackground}
              onChange={(e) => patch({ removeBackground: e.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-500"
            />
            <span className="text-sm text-text-primary">
              Hapus background avatar
              <span className="block text-[10px] text-text-secondary">
                Menyisakan orangnya saja (background foto dihilangkan otomatis di server). Menambah sedikit waktu render dan butuh Colab dijalankan ulang agar model matting terpasang.
              </span>
            </span>
          </label>

          {/* Optional per-request Colab URL override */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Avatar Colab URL (opsional)</span>
            <input
              type="text"
              value={overlay.colabUrl ?? ''}
              onChange={(e) => patch({ colabUrl: e.target.value || undefined })}
              placeholder="Kosongkan untuk memakai URL voice clone (XTTS/VoxCPM) dari Settings"
              className="rounded-lg border border-white/10 bg-surface-elevated px-3 py-2 text-xs text-text-primary focus:border-indigo-500 focus:outline-none"
            />
            <p className="text-[10px] text-text-secondary">
              Jika kosong, avatar di-generate lewat Colab URL yang sama dengan voice clone Anda.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
