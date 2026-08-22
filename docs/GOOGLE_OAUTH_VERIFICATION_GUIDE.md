# Panduan Verifikasi OAuth Google & YouTube

Dokumen ini berisi checklist, domain hosting, dan naskah video demo untuk pengajuan verifikasi OAuth app di Google Cloud Console.

---

## 1. Hosting Privacy Policy & Terms of Service (Gratis)

Google mewajibkan Privacy Policy dan Terms of Service memiliki URL publik aktif (`https://`).

### Opsi Termudah: GitHub Pages
1. Push file `docs/privacy-policy.html` dan `docs/terms-of-service.html` ke GitHub repo.
2. Buka GitHub Repo $\rightarrow$ **Settings** $\rightarrow$ **Pages**.
3. Pilih source: **Deploy from a branch** $\rightarrow$ `main` / `docs` folder $\rightarrow$ **Save**.
4. URL publik akan jadi:
   - Privacy Policy: `https://<username>.github.io/<repo>/privacy-policy.html`
   - Terms of Service: `https://<username>.github.io/<repo>/terms-of-service.html`
   - Domain Utama: `https://<username>.github.io/<repo>/`

*(Alternatif: Deploy ke Vercel, Netlify, atau Cloudflare Pages).*

---

## 2. Setting di Google Cloud Console

Buka [Google Cloud Console](https://console.cloud.google.com/) $\rightarrow$ **APIs & Services** $\rightarrow$ **OAuth consent screen**:

1. **App Information**:
   - App Name: `Shorts Editor` (harus sama persis dengan nama di aplikasi)
   - User support email: `admin@dionesiamusik.biz.id`
   - Developer contact information: `admin@dionesiamusik.biz.id`
   - App domain (jika host di domain sendiri `dionesiamusik.biz.id`):
     - Application home page: `https://dionesiamusik.biz.id/`
     - Privacy Policy link: `https://dionesiamusik.biz.id/privacy-policy.html`
     - Terms of Service link: `https://dionesiamusik.biz.id/terms-of-service.html`
   - Authorized domains: `dionesiamusik.biz.id` (atau domain tempat hosting)

2. **Scopes**:
   Tambahkan scope yang dipakai:
   - `https://www.googleapis.com/auth/youtube.upload` (Restricted/Sensitive)
   - `https://www.googleapis.com/auth/youtube.readonly` (Sensitive)
   - `https://www.googleapis.com/auth/userinfo.email`

3. **Domain Verification** (Opsional jika pakai domain sendiri):
   - Daftarkan domain di [Google Search Console](https://search.google.com/search-console).

---

## 3. Checklist & Naskah Video Demo (YouTube Upload)

Google mewajibkan rekaman video demo (upload ke YouTube sebagai **Unlisted**) berdurasi 1-3 menit.

### Aturan Wajib Google untuk Video Demo:
1. **Tampilkan Client ID di URL bar**: Saat popup/browser OAuth Google terbuka, sorot URL bar dan perlihatkan parameter `client_id=...` yang cocok dengan Client ID di Google Cloud Console.
2. **Tampilkan Alur Lengkap**: Dari klik tombol "Connect YouTube" di Shorts Editor $\rightarrow$ popup login Google $\rightarrow$ consent screen izin scope $\rightarrow$ sukses terhubung.
3. **Tampilkan Penggunaan Scope**:
   - `youtube.readonly`: Tampilkan profil/nama channel yang berhasil dimuat di aplikasi.
   - `youtube.upload`: Tampilkan proses render/publish video dari Shorts Editor sampai berhasil terunggah ke YouTube Studio/Channel.
4. **Bahasa Audio / Teks**: Bahasa Inggris atau sertakan subtitle/teks penjelasan bahasa Inggris.

---

### Naskah / Alur Rekaman Video Demo (1-2 Menit)

* **Scene 1: Pengenalan Aplikasi (0:00 - 0:20)**
  - Tampilkan interface Shorts Editor.
  - Teks/Narasi: *"Shorts Editor is a desktop tool for creators to edit short-form videos and publish them directly to YouTube."*

* **Scene 2: OAuth Flow & Client ID (0:20 - 0:50)**
  - Buka Settings $\rightarrow$ Klik **Connect YouTube Account**.
  - Browser terbuka menuju halaman login Google.
  - **PENTING**: Zoom/Sorot URL bar browser, tunjukkan `client_id` di URL `accounts.google.com/o/oauth2/v2/auth?...client_id=YOUR_CLIENT_ID...`.
  - Pilih akun Google, klik Allow/Izinkan semua scope (`youtube.upload`, `youtube.readonly`, `email`).

* **Scene 3: Scope `youtube.readonly` Digunakan (0:50 - 1:10)**
  - Kembali ke Shorts Editor. Tunjukkan nama channel / email yang terhubung sudah muncul.
  - Teks/Narasi: *"The app uses youtube.readonly to display the active channel information."*

* **Scene 4: Scope `youtube.upload` Digunakan (1:10 - 1:45)**
  - Buka video yang sudah selesai diproses di Shorts Editor.
  - Klik Publish / Upload to YouTube. Masukkan Title & Description.
  - Klik Upload. Tunggu upload selesai.
  - Buka YouTube Studio di browser untuk membuktikan video sudah masuk di channel pengguna.
  - Teks/Narasi: *"The app uses youtube.upload strictly to upload user-created videos upon user request."*

---

## 4. Penjelasan Scope untuk Form Submit Google

Saat klik **Submit for Verification**, Google meminta alasan teks untuk setiap scope:

* **Scope `youtube.upload`**:
  > *"Shorts Editor is a video production desktop app for creators. This scope is required so users can upload their edited video shorts directly to their authorized YouTube channel without leaving the application."*

* **Scope `youtube.readonly`**:
  > *"This scope is used to display the connected YouTube channel name and profile info in the settings screen, ensuring the user is uploading to the correct channel."*

* **Scope `userinfo.email`**:
  > *"Used to display the authenticated account email address in the user settings UI."*
