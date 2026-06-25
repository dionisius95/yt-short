# Requirements Document

## Introduction

Fitur ini menambahkan input opsional tema/mood (momentTheme) ke dalam alur hook detection. User dapat mengetikkan tema atau mood tertentu (misalnya "lucu", "inspiratif", "gaming") di panel Hooks sebelum menjalankan Run Analysis. Tema tersebut diteruskan sebagai soft preference ke LLM prompt, sehingga AI tetap mencari momen viral secara umum namun memberikan bobot lebih pada segmen yang relevan dengan tema yang dipilih. Perubahan bersifat backward-compatible — jika tema tidak diisi, perilaku analisis tidak berubah.

## Glossary

- **HookListPanel**: Komponen React di kolom tengah Project View yang menampilkan daftar hook hasil analisis.
- **ProjectViewClient**: Komponen halaman utama Project View yang mengatur state dan memanggil IPC.
- **IPC Client**: Modul `ipc-client.ts` di renderer yang membungkus `window.electron.invoke()` dengan tipe TypeScript.
- **Handler**: Fungsi di `handlers.ts` (main process) yang menerima panggilan IPC dari renderer dan mendelegasikan ke services.
- **Analyzer**: Kelas `Analyzer.ts` di pipeline main process yang menjalankan deteksi hook menggunakan LLM (Gemini atau Ollama).
- **momentTheme**: String opsional yang merepresentasikan tema atau mood yang diinginkan user untuk memfilter/membobot hasil deteksi hook.
- **Soft Preference**: Pendekatan di mana momentTheme digunakan sebagai instruksi tambahan dalam prompt LLM tanpa menggantikan logika deteksi momen viral secara umum.
- **System Prompt**: Bagian prompt yang dikirim ke LLM sebagai instruksi sistem untuk menentukan perilaku analisis.

## Requirements

### Requirement 1: Input Tema di HookListPanel

**User Story:** Sebagai user, saya ingin dapat memasukkan tema atau mood opsional di panel Hooks sebelum menjalankan analisis, sehingga hasil hook yang ditemukan lebih relevan dengan konten yang saya targetkan.

#### Acceptance Criteria

1. THE HookListPanel SHALL menampilkan input teks bertipe opsional untuk momentTheme di area header panel, di atas atau sebagai bagian dari elemen header yang sudah ada.
2. WHEN HookListPanel dirender, THE HookListPanel SHALL menampilkan input momentTheme dalam kondisi kosong sebagai nilai default.
3. THE HookListPanel SHALL menampilkan placeholder text pada input momentTheme yang menjelaskan contoh penggunaan (misalnya "lucu, inspiratif, gaming…").
4. WHEN user mengubah nilai input momentTheme, THE HookListPanel SHALL menyimpan nilai tersebut ke state lokal komponen.
5. THE HookListPanel SHALL menampilkan tombol clear (×) pada input momentTheme apabila nilai input tidak kosong, sehingga user dapat menghapus tema dengan satu klik.
6. WHEN user mengklik tombol clear pada input momentTheme, THE HookListPanel SHALL mengosongkan nilai momentTheme di state lokal.
7. THE HookListPanel SHALL meneruskan nilai momentTheme saat ini kepada callback onRunAnalysis milik parent component setiap kali analisis dijalankan.
8. WHILE analyzing bernilai true, THE HookListPanel SHALL menonaktifkan input momentTheme agar user tidak dapat mengubah tema selama analisis berlangsung.

### Requirement 2: Propagasi momentTheme dari ProjectViewClient ke IPC

**User Story:** Sebagai developer, saya ingin nilai momentTheme diteruskan dari UI ke lapisan IPC secara backward-compatible, sehingga channel `analyze:start` tetap berfungsi normal jika tema tidak diisi.

#### Acceptance Criteria

1. THE ProjectViewClient SHALL menerima nilai momentTheme dari HookListPanel melalui callback onRunAnalysis.
2. WHEN handleRunAnalysis dipanggil dengan momentTheme yang tidak kosong, THE ProjectViewClient SHALL meneruskan nilai momentTheme tersebut ke `ipc.analyze.start()` sebagai argumen opsional.
3. WHEN handleRunAnalysis dipanggil tanpa momentTheme atau dengan string kosong, THE ProjectViewClient SHALL memanggil `ipc.analyze.start()` tanpa argumen momentTheme sehingga perilaku analisis tidak berubah.
4. THE IPC Client SHALL mendefinisikan signature `ipc.analyze.start(projectId: string, momentTheme?: string): Promise<Hook[]>` agar parameter momentTheme bersifat opsional.
5. WHEN `ipc.analyze.start()` dipanggil dengan momentTheme, THE IPC Client SHALL meneruskan nilai tersebut ke channel `analyze:start` sebagai argumen tambahan setelah projectId.
6. WHEN `ipc.analyze.start()` dipanggil tanpa momentTheme, THE IPC Client SHALL memanggil channel `analyze:start` hanya dengan projectId, sehingga handler di main process menerima undefined untuk parameter momentTheme.

### Requirement 3: Penerimaan momentTheme di IPC Handler

**User Story:** Sebagai developer, saya ingin handler `analyze:start` di main process menerima dan meneruskan momentTheme ke service layer, sehingga tema dapat digunakan dalam proses analisis.

#### Acceptance Criteria

1. THE Handler SHALL memperbarui handler `analyze:start` untuk menerima parameter opsional `momentTheme?: string` di samping `projectId`.
2. WHEN handler `analyze:start` menerima panggilan IPC dengan momentTheme, THE Handler SHALL meneruskan nilai momentTheme tersebut ke `services.startAnalyze()`.
3. WHEN handler `analyze:start` menerima panggilan IPC tanpa momentTheme, THE Handler SHALL memanggil `services.startAnalyze(projectId)` tanpa argumen momentTheme sehingga analisis berjalan seperti sebelumnya.
4. THE IpcServices interface SHALL mendefinisikan `startAnalyze` dengan signature `(projectId: string, momentTheme?: string) => Promise<unknown[]>` agar kontrak service bersifat backward-compatible.

### Requirement 4: Integrasi momentTheme ke LLM Prompt di Analyzer

**User Story:** Sebagai user, saya ingin tema yang saya masukkan digunakan sebagai preferensi tambahan dalam analisis AI, sehingga AI memberikan bobot lebih pada momen yang relevan dengan tema tanpa mengabaikan momen viral lainnya.

#### Acceptance Criteria

1. THE Analyzer SHALL memperbarui signature method `detectHooks()` untuk menerima parameter opsional `momentTheme?: string`.
2. WHEN `detectHooks()` dipanggil dengan momentTheme yang memiliki nilai, THE Analyzer SHALL menyertakan instruksi tema sebagai soft preference dalam system prompt yang dikirim ke LLM.
3. WHEN `detectHooks()` dipanggil tanpa momentTheme atau dengan nilai undefined, THE Analyzer SHALL menghasilkan system prompt yang identik dengan prompt sebelum fitur ini ditambahkan, sehingga tidak ada perubahan perilaku.
4. THE Analyzer SHALL memformat instruksi tema dalam system prompt sebagai preferensi tambahan (bukan filter wajib), misalnya: "If relevant to the theme, give higher priority to segments matching: {momentTheme}."
5. WHEN momentTheme disediakan, THE Analyzer SHALL menerapkan instruksi tema tersebut baik pada alur Gemini maupun alur Ollama, sehingga kedua path LLM mendapat konteks tema yang sama.
6. IF momentTheme mengandung karakter yang dapat merusak struktur JSON prompt (seperti karakter kontrol atau string yang sangat panjang lebih dari 200 karakter), THEN THE Analyzer SHALL memotong atau membersihkan nilai tersebut sebelum disertakan dalam prompt.
