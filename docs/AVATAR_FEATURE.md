# Talking Avatar untuk Commentary — Integration Guide

Fitur **additive**: avatar bicara dari foto yang di-upload user, di-generate
lewat **URL base yang sama** dengan voice clone VoxCPM/XTTS (route baru
`/avatar`), dengan **toggle** dan **pilihan posisi**.

> **Jaminan fallback:** kalau `avatar.enabled === false`, tidak ada gambar, atau
> endpoint gagal -> pipeline lama (`renderCommentaryVideo`) berjalan **tanpa
> perubahan apa pun**.

File baru yang sudah ada di PR ini (aman, tidak menyentuh file lama):

- `shared/avatarTypes.ts` — tipe `AvatarOverlay`, `AvatarClips`, `AvatarPosition`.
- `electron/pipeline/AvatarGenerator.ts` — klien endpoint `/avatar` (base64, validasi mp4, retry, timeout besar).
- `colab/avatar_server.py`, `colab/setup_colab.sh`, `colab/README.md` — server Colab T4.

Bagian di bawah adalah **patch untuk file besar** (types, pipeline, processor, UI)
yang sengaja TIDAK di-commit otomatis agar tidak berisiko menimpa file besar.
Terapkan sesuai kebutuhan.

## Segment mapping (mode `hook_replay_outro`)

| Segment | TTS | Avatar |
| --- | --- | --- |
| A — Hook | `ttsTrackPath` | `talk` (lip-sync + blink) |
| B — Replay | — (audio asli) | `idle` (diam, kedip/ekspresif). **Subtitle replay tetap tampil** |
| C — Takeaway | `takeawayTtsPath` | `talk` (lip-sync + blink) |

---

## Patch 1 — `shared/types.ts`

Tambahkan import + field opsional (semua optional, default off):

```ts
import type { AvatarOverlay } from './avatarTypes';

// di dalam interface CommentatorRequest { ... }
  /** Optional talking-avatar overlay. Omitted/disabled -> pipeline unchanged. */
  avatar?: AvatarOverlay;

// di dalam interface AppSettings { ... }
  /** Optional dedicated avatar engine base URL. Empty -> falls back to xttsColabUrl. */
  avatarColabUrl?: string;
```

---

## Patch 2 — `electron/pipeline/CommentatorPipeline.ts`

Import generator di atas file:

```ts
import { AvatarGenerator } from './AvatarGenerator';
import type { AvatarClips } from '../../shared/avatarTypes';
```

Tambahkan properti kelas:

```ts
  private avatar = new AvatarGenerator();
```

Sebelum pemanggilan `this.processor.renderCommentaryVideo({ ... })`, sisipkan
blok guarded ini (menghasilkan klip avatar per-segmen; kalau gagal -> dibiarkan
kosong sehingga render tetap normal):

```ts
// ---- Talking avatar (ADDITIVE, guarded) --------------------------------
let avatarClips: AvatarClips | undefined;
if (req.avatar?.enabled && req.avatar.imagePath && fs.existsSync(req.avatar.imagePath)) {
  try {
    const baseUrl = AvatarGenerator.resolveBaseUrl(req.avatar, apiKeys.xttsColabUrl);
    if (!baseUrl) throw new Error('avatar base URL kosong (set xttsColabUrl / avatar.colabUrl)');
    this._emitProgress(84, 'avatar', 'Generating talking avatar clips...');
    const dir = outputDir || path.dirname(videoPath);
    const clips: AvatarClips = {};

    // Segment A (hook) -> talk
    clips.segmentA = await this.avatar.generate({
      imagePath: req.avatar.imagePath,
      audioPath: ttsTrackPath,
      mode: 'talk',
      baseUrl,
      outputPath: path.join(dir, 'avatar_segA.mp4'),
    });

    // Segment C (takeaway) -> talk (only in 3-segment mode)
    if (is3Segment && takeawayTtsPath) {
      clips.segmentC = await this.avatar.generate({
        imagePath: req.avatar.imagePath,
        audioPath: takeawayTtsPath,
        mode: 'talk',
        baseUrl,
        outputPath: path.join(dir, 'avatar_segC.mp4'),
      });
    }

    // Segment B (replay) -> idle (silent, blinking). Duration ~ source clip.
    if (is3Segment) {
      clips.segmentB = await this.avatar.generate({
        imagePath: req.avatar.imagePath,
        audioPath: null,
        mode: 'idle',
        baseUrl,
        outputPath: path.join(dir, 'avatar_segB.mp4'),
        durationSec: Math.max(1, Math.round(durationMs / 1000)),
      });
    }

    avatarClips = clips;
  } catch (avErr) {
    log.warn({ avErr }, 'Avatar generation failed; falling back to standard render');
    avatarClips = undefined; // fallback: render tanpa avatar
  }
}
```

Lalu tambahkan **field** pada argumen `renderCommentaryVideo({ ... })`:

```ts
  avatar: req.avatar,        // posisi/shape/scale
  avatarClips,               // undefined -> render lama tak berubah
```

---

## Patch 3 — `electron/pipeline/Processor.ts` (`renderCommentaryVideo`)

Tambahkan dua field opsional di tipe argumen method:

```ts
  avatar?: import('../../shared/avatarTypes').AvatarOverlay;
  avatarClips?: import('../../shared/avatarTypes').AvatarClips;
```

Di dalam method, sebelum membangun graph FFmpeg final, hitung posisi overlay
(pola sama seperti `LogoOverlay`) dan overlay klip avatar HANYA jika ada. Kalau
`avatarClips` undefined, jangan ubah apa pun (jalur lama).

Contoh helper posisi (canvas 1080x1920):

```ts
function avatarXY(a: AvatarOverlay): { x: string; y: string } {
  const w = Math.round(1080 * a.scale);      // lebar avatar
  const m = a.margin ?? 48;
  if (typeof a.x === 'number' && typeof a.y === 'number') {
    return { x: `${a.x}`, y: `${a.y}` };
  }
  const left = `${m}`;
  const right = `${1080 - w - m}`;
  const top = `${m}`;
  // Segment B: JANGAN taruh di bawah (nabrak subtitle). Default atas.
  switch (a.position) {
    case 'top-left': return { x: left, y: top };
    case 'top-right': return { x: right, y: top };
    case 'bottom-left': return { x: left, y: `1920-h-${m}` };
    case 'bottom-right': return { x: right, y: `1920-h-${m}` };
    case 'center': return { x: `(1080-w)/2`, y: `(1920-h)/2` };
  }
}
```

Sketsa filter (per segmen, overlay avatar di atas video utama):

```
[avatar]scale=<w>:-1[av];
[main][av]overlay=<x>:<y>:enable='between(t,<segStart>,<segEnd>)'
```

Untuk `shape: 'circle'`, tambahkan mask bulat via `geq`/`alphamerge` sebelum
overlay. Untuk Segment B, kunci posisi ke area atas agar **subtitle replay**
(biasanya bawah-tengah) tidak tertutup.

> Penting: bungkus seluruh logika overlay dengan `if (avatarClips) { ... }`
> supaya render mode lama byte-for-byte identik saat avatar nonaktif.

---

## Patch 4 — UI (renderer)

Di modal Commentator & halaman Settings, tambahkan:

- Toggle **Talking Avatar** (`avatar.enabled`).
- **Upload gambar** (`avatar.imagePath`).
- **Pemilih posisi** (`avatar.position`) + slider `scale` + toggle `shape`.
- (Settings) input opsional `avatarColabUrl` (default pakai `xttsColabUrl`).

Contoh state awal aman:

```ts
import { DEFAULT_AVATAR_OVERLAY } from '../../shared/avatarTypes';
const [avatar, setAvatar] = useState({ ...DEFAULT_AVATAR_OVERLAY });
```

Kirim `avatar` sebagai bagian dari `CommentatorRequest` saat submit. Karena
default `enabled: false`, perilaku lama tetap default.

---

## Testing checklist

- [ ] Toggle OFF -> output identik dengan sebelum fitur (regresi nol).
- [ ] Toggle ON tanpa gambar -> fallback, tidak error.
- [ ] Endpoint mati/timeout -> fallback ke render standar.
- [ ] Mode `hook_replay_outro`: A bicara, B idle, C bicara.
- [ ] Subtitle Segment B tetap tampil & tidak tertutup avatar.
- [ ] Posisi avatar mengikuti pilihan user; `circle` termask dengan benar.
