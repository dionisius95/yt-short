'use client';

/**
 * AvatarControls — UI for the optional Talking Avatar overlay on Commentary
 * videos (3-segment / hook_replay_outro mode).
 *
 * Fully additive: when `value.enabled` is false (the default) the parent must
 * ignore the rest of the overlay config and keep the existing commentary
 * pipeline output unchanged.
 */

import { ipc } from '../../lib/ipc-client';
import { cn } from '../../lib/utils';
import {
  DEFAULT_AVATAR_OVERLAY,
  type AvatarOverlay,
  type AvatarPosition,
  type AvatarShape,
} from '../../../shared/avatarTypes';

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

export function AvatarControls({ value, onChange }: AvatarControlsProps) {
  const overlay: AvatarOverlay = { ...DEFAULT_AVATAR_OVERLAY, ...(value ?? {}) };

  const patch = (partial: Partial<AvatarOverlay>) =>
    onChange({ ...overlay, ...partial });

  const handlePickImage = async () => {
    try {
      const file = await ipc.dialog.openFile();
      if (file) patch({ imagePath: file });
    } catch {
      /* cancelled */
    }
  };

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

          {/* Position */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Posisi Avatar</span>
            <div className="flex flex-wrap gap-2">
              {POSITION_OPTS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patch({ position: opt.value })}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-xs font-medium transition-all',
                    overlay.position === opt.value
                      ? 'border-indigo-500/80 bg-indigo-500/20 text-indigo-200 ring-2 ring-indigo-500/30'
                      : 'border-white/10 bg-surface-elevated/40 text-text-secondary hover:bg-white/5 hover:text-text-primary'
                  )}
                >
                  {opt.label}
                </button>
              ))}
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
