# Perubahan: YouTube Discovery di Dashboard

Fitur baru di UI awal (Dashboard) untuk menemukan video langsung dari YouTube
dan mengimpornya ke pipeline.

## Fitur
- **Sedang Tren**: menampilkan video paling populer (chart `mostPopular`) per
  audiens/negara, dengan filter kategori (Musik, Gaming, Hiburan, dll).
- **Cari Video**: pencarian kata kunci (search.list) dengan pilihan audiens.
- **Pilihan audiens (negara)**: Indonesia, AS, Inggris, Kanada, Australia,
  Jerman, India, Jepang, Brasil, Filipina. Negara ber-RPM tinggi ditandai
  "RPM tinggi".
- **Import 1 klik**: tiap hasil punya tombol Import yang mengarahkan ke
  `/import?url=...` — memakai alur download → clip yang sudah ada.

## File yang ditambah/diubah
- `electron/services/YouTubeDiscovery.ts` (baru) — panggilan YouTube Data API v3
  (search.list + videos.list, parsing durasi/statistik).
- `electron/ipc/channels.ts`, `electron/ipc/handlers.ts`, `electron/preload.ts`,
  `electron/main.ts` — channel & handler `youtube:search` / `youtube:trending`.
- `electron/config/ConfigManager.ts`, `shared/types.ts` — setelan `youtubeApiKey`
  + tipe `YouTubeVideoResult` / `YouTubeSearchParams` / `YouTubeTrendingParams`.
- `renderer/lib/ipc-client.ts` — `ipc.youtube.search` / `ipc.youtube.trending`.
- `renderer/components/discover/DiscoverPanel.tsx` (baru) — panel UI.
- `renderer/app/page.tsx` — menampilkan panel di Dashboard.
- `renderer/components/settings/SettingsForm.tsx` — input "YouTube Data API Key".

## Cara pakai (PENTING: butuh API key)
1. Buka Google Cloud Console → buat project → aktifkan **YouTube Data API v3**.
2. Buat **API key** (Credentials → Create credentials → API key).
3. Tempel di app: **Settings → YouTube Account → YouTube Data API Key** → Save.
4. Buka Dashboard → panel "Temukan video dari YouTube".

Catatan kuota: API gratis ~10.000 unit/hari. `search` = 100 unit/panggilan,
`trending` = ~1–3 unit. Jadi pencarian jauh lebih boros kuota daripada tren.

## Pengingat hak cipta
Menemukan video di sini TIDAK memberi hak untuk memakainya. Mengimpor lalu
meng-upload ulang video milik orang lain tetap bisa kena Content ID / klaim
hak cipta jika kamu tidak memiliki/melisensikan materinya.
