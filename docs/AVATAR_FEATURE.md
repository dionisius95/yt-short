# Talking Avatar untuk Commentary — Status & Integration

Fitur **additive**: avatar bicara dari foto yang di-upload user, di-generate
lewat **URL base yang sama** dengan voice clone VoxCPM/XTTS (route baru
`/avatar`), dengan **toggle** dan **pilihan posisi**.

> **Jaminan fallback:** kalau `avatar.enabled === false`, tidak ada gambar, atau
> proses gagal -> pipeline lama (`renderCommentaryVideo`) berjalan **tanpa
> perubahan apa pun**. `Processor.ts` **tidak diubah sama sekali**.

## Sudah TERPASANG di branch ini

- `shared/avatarTypes.ts` — tipe `AvatarOverlay`/`AvatarClips` + **module
  augmentation** yang menambah `CommentatorRequest.avatar` dan
  `AppSettings.avatarColabUrl` tanpa mengedit `types.ts` besar.
- `electron/pipeline/AvatarGenerator.ts` — klien endpoint `/avatar` (base64,
  validasi mp4 `ftyp`, retry, timeout ~8 menit).
- `electron/pipeline/AvatarCompositor.ts` — overlay klip avatar ke video hasil
  render via **satu pass FFmpeg** (rect/circle, posisi, di-gate per waktu).
  Menulis ke file temp lalu rename saat sukses -> aman.
- `electron/pipeline/CommentatorPipeline.ts` — untuk mode `hook_replay_outro`:
  generate klip A/C (talk) + B (idle), lalu composite ke output. Semua *guarded*.
- `colab/avatar_server.py`, `colab/setup_colab.sh`, `colab/README.md` — server
  Colab T4 (SadTalker talk + LivePortrait idle).

## Segment mapping (mode `hook_replay_outro`)

| Segment | TTS | Avatar | Window (perkiraan) |
| --- | --- | --- | --- |
| A — Hook | `ttsTrackPath` | `talk` (lip-sync + kedip) | `[0, tA]` |
| B — Replay | — (audio asli) | `idle` (diam, ekspresif). **Subtitle replay tetap tampil** | `[tA, tA+tB]` |
| C — Takeaway | `takeawayTtsPath` | `talk` (lip-sync + kedip) | `[tA+tB, tA+tB+tC]` |

`tA` = durasi TTS hook, `tB` = durasi klip replay (`durationMs`), `tC` = durasi
TTS takeaway. Compositor memakai `-itsoffset` agar tiap klip avatar mulai tepat
di awal segmennya, dan `overlay=...:enable='between(t,start,end)'` untuk gating.

## Yang MASIH manual — Patch UI (renderer)

Satu-satunya bagian yang belum otomatis, karena butuh menyentuh komponen UI.
Di modal Commentator & halaman Settings tambahkan:

- Toggle **Talking Avatar** (`avatar.enabled`).
- **Upload gambar** (`avatar.imagePath`).
- **Pemilih posisi** (`avatar.position`) + slider `scale` + toggle `shape`
  ('rect' | 'circle').
- (Settings) input opsional `avatarColabUrl` (default pakai `xttsColabUrl`).

Contoh state awal aman:

```ts
import { DEFAULT_AVATAR_OVERLAY } from '../../shared/avatarTypes';
const [avatar, setAvatar] = useState({ ...DEFAULT_AVATAR_OVERLAY });
```

Kirim `avatar` sebagai bagian dari `CommentatorRequest` saat submit. Karena
default `enabled: false`, perilaku lama tetap jadi default.

## Catatan posisi & subtitle (Segment B)

Subtitle replay biasanya di bawah-tengah. Supaya avatar tidak menutupinya saat
Segment B, pilih posisi **atas** (`top-left`/`top-right`) di UI, atau set
`avatar.y` manual ke area atas. Compositor menghormati `position`, `x/y`,
`scale`, `margin`, dan `shape`.

## Engine & T4

- **SadTalker** untuk talk (A/C), **LivePortrait** untuk idle (B). Nyaman di T4
  (16GB): resolusi ≤512px, fp16, fps 25. Naikkan timeout di sisi app (avatar
  butuh menitan).
- Kalau LivePortrait/idle driving tidak ada, `idle` fallback ke SadTalker still.

## Testing checklist

- [ ] Toggle OFF -> output identik dengan sebelum fitur (regresi nol).
- [ ] Toggle ON tanpa gambar -> fallback, tidak error.
- [ ] Endpoint mati/timeout -> fallback ke render standar.
- [ ] Compositing gagal -> video commentary asli tetap utuh.
- [ ] Mode `hook_replay_outro`: A bicara, B idle, C bicara.
- [ ] Subtitle Segment B tetap tampil & tidak tertutup avatar.
- [ ] Posisi avatar mengikuti pilihan user; `circle` termask dengan benar.
