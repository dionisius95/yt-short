# Perubahan: Fitur Kepatuhan Hak Cipta

Tiga fitur legitimat ditambahkan untuk mengurangi risiko klaim/blokir hak cipta
di YouTube. **Catatan penting:** tidak ada kode yang bisa "menghindari" Content ID
pada materi yang memang dilindungi hak cipta. Fitur ini membantu kepatuhan, bukan
mengelabui sistem deteksi.

## 1. Atribusi sumber otomatis
- Setelan baru: `autoAttribution` (default: aktif) + `attributionTemplate`.
- Saat upload, kredit sumber otomatis ditambahkan ke deskripsi video — hanya untuk
  sumber hasil unduhan (URL), bukan file lokal milik sendiri (`file://`).
- Placeholder `{title}` dan `{url}` diganti dengan data video sumber.
- File: `electron/main.ts` (startUpload), `shared/types.ts`, `electron/config/ConfigManager.ts`.

## 2. Opsi audio: Keep / Mute / Replace
- Setelan baru: `defaultAudioMode`, `backgroundMusicPath`, `musicVolume`.
- `mute`  : menghapus audio asli (paling efektif & legitimat untuk menghindari klaim audio).
- `replace`: mengganti audio asli dengan musik milik/berlisensi sendiri (loop, volume diatur).
- `keep`  : perilaku lama (audio asli dipertahankan).
- Bisa di-override per klip lewat opsi generate.
- File: `electron/pipeline/Processor.ts` (metode `_applyAudioTreatment`, Step 3.5),
  `electron/main.ts` (generateClip), `shared/types.ts`, `electron/config/ConfigManager.ts`.

## 3. Gate konfirmasi hak / lisensi
- Form import kini mewajibkan centang konfirmasi bahwa pengguna memiliki hak/izin
  atas materi sebelum proses dapat dijalankan.
- File: `renderer/components/import/ImportForm.tsx`.

## Pengaturan UI
- Section baru "Copyright & Audio" di halaman Settings
  (`renderer/components/settings/SettingsForm.tsx`).

---
Yang TIDAK dilakukan (sengaja, karena melanggar ToS YouTube & tidak etis):
teknik mengakali Content ID seperti pitch-shift, mirror, ubah kecepatan, atau crop
untuk mengaburkan fingerprint. Itu tidak diimplementasikan.
