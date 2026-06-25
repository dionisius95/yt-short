# Design Document — hook-moment-theme

## Overview

Fitur ini menambahkan parameter opsional `momentTheme` ke seluruh stack: dari input UI di `HookListPanel`, diteruskan melalui `ProjectViewClient` → IPC Client → IPC Handler → `Analyzer.detectHooks()`, di mana nilai tersebut diinjeksikan ke system prompt LLM sebagai *soft preference*. Semua perubahan bersifat backward-compatible — jika `momentTheme` tidak diisi, perilaku identik dengan sebelumnya.

---

## Architecture

```
HookListPanel (state: momentTheme)
    │  onRunAnalysis(momentTheme)
    ▼
ProjectViewClient.handleRunAnalysis(momentTheme)
    │  ipc.analyze.start(projectId, momentTheme?)
    ▼
ipc-client.ts  → invoke('analyze:start', projectId, momentTheme?)
    │  IPC bridge (Electron preload)
    ▼
handlers.ts  → ipcMain.handle('analyze:start', (_, projectId, momentTheme?))
    │  services.startAnalyze(projectId, momentTheme?)
    ▼
PipelineManager / Analyzer.detectHooks(projectId, transcript, ..., momentTheme?)
    │  buildSystemPrompt(durationMs, language, momentTheme?)
    ▼
LLM (Gemini or Ollama) — receives enriched system prompt
```

Data hanya mengalir satu arah. Tidak ada state baru di sisi main process; `momentTheme` cukup dioper sebagai parameter fungsi di setiap lapisan.

---

## Components and Interfaces

### 1. `HookListPanel.tsx` — UI input

**Perubahan:**

- Tambah state lokal: `const [momentTheme, setMomentTheme] = useState('')`
- Tambah prop baru di `HookListPanelProps`: `onRunAnalysis: (momentTheme: string) => void`
- Render input teks di header panel (di bawah search bar atau di atas tombol "Run Analysis" yang ada di parent), dengan:
  - `placeholder="lucu, inspiratif, gaming…"`
  - `disabled={analyzing}`
  - Tombol clear `×` muncul jika `momentTheme !== ''`
- Saat analisis dijalankan (dari tombol di header panel jika ditambah, atau diteruskan ke parent), panggil `onRunAnalysis(momentTheme)`

**Catatan:** Tombol "Run Analysis" saat ini ada di `ProjectViewClient` (TopBar actions). Karena `momentTheme` adalah state lokal `HookListPanel`, callback `onRunAnalysis` diteruskan ke parent agar parent bisa memanggil IPC dengan nilai tersebut. Alternatifnya adalah mengangkat state ke parent — namun pendekatan callback lebih minimal.

**Interface yang diubah:**

```typescript
interface HookListPanelProps {
  // ... existing props ...
  onRunAnalysis: (momentTheme: string) => void;  // NEW — menggantikan tidak ada callback sebelumnya
}
```

**Render input momentTheme (di dalam header `<div>`):**

```tsx
{/* Moment theme input */}
<div className="relative">
  <input
    type="text"
    value={momentTheme}
    onChange={(e) => setMomentTheme(e.target.value)}
    placeholder="lucu, inspiratif, gaming…"
    disabled={analyzing}
    aria-label="Tema atau mood untuk analisis"
    className={cn(
      'w-full rounded-md border border-border bg-surface px-3 py-1.5',
      'text-xs text-text-primary placeholder:text-text-secondary',
      'focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent/60',
      'disabled:opacity-50 disabled:cursor-not-allowed transition-micro'
    )}
  />
  {momentTheme && (
    <button
      type="button"
      onClick={() => setMomentTheme('')}
      aria-label="Hapus tema"
      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-micro"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  )}
</div>
```

---

### 2. `ProjectViewClient.tsx` — Propagasi ke IPC

**Perubahan:**

- `handleRunAnalysis` menerima `momentTheme: string` sebagai parameter
- Teruskan ke `ipc.analyze.start()` hanya jika tidak kosong

```typescript
const handleRunAnalysis = async (momentTheme: string) => {
  setAnalyzing(true);
  setOllamaError(false);
  try {
    const trimmed = momentTheme.trim();
    const newHooks = trimmed
      ? await ipc.analyze.start(projectId, trimmed)
      : await ipc.analyze.start(projectId);
    // ... rest unchanged
  }
  // ...
};
```

- `HookListPanel` menerima prop `onRunAnalysis`:

```tsx
<HookListPanel
  // ... existing props ...
  onRunAnalysis={(theme) => void handleRunAnalysis(theme)}
/>
```

- Tombol "Run Analysis" di TopBar tetap ada sebagai shortcut; ia memanggil `handleRunAnalysis('')` (tanpa tema) — backward-compatible.

---

### 3. `ipc-client.ts` — Typed IPC wrapper

**Perubahan di `analyze.start`:**

```typescript
analyze: {
  start(projectId: string, momentTheme?: string): Promise<Hook[]> {
    return momentTheme
      ? invoke<Hook[]>('analyze:start', projectId, momentTheme)
      : invoke<Hook[]>('analyze:start', projectId);
  },
  // ... rest unchanged
},
```

Pengecekan `momentTheme` di sisi client memastikan channel `analyze:start` tidak pernah menerima `undefined` sebagai argumen eksplisit — handler di main process menerima `undefined` secara alami melalui destructuring saat argumen tidak dikirim.

---

### 4. `handlers.ts` — IPC Handler & IpcServices interface

**Perubahan di `IpcServices`:**

```typescript
/** Runs hook analysis and returns hooks */
startAnalyze: (projectId: string, momentTheme?: string) => Promise<unknown[]>;
```

**Perubahan di handler `ANALYZE_START`:**

```typescript
ipcMain.handle(CHANNELS.ANALYZE_START, async (_event, projectId: string, momentTheme?: string) => {
  return services.startAnalyze(projectId, momentTheme);
});
```

---

### 5. `Analyzer.ts` — LLM prompt injection

**Perubahan di `detectHooks` signature:**

```typescript
async detectHooks(
  projectId: string,
  transcript: Transcript,
  modelName: string = 'llama3',
  durationMs?: number,
  geminiApiKey?: string,
  serviceAccountPath?: string,
  momentTheme?: string,   // NEW — opsional, soft preference
): Promise<Hook[]>
```

**Perubahan di `buildSystemPrompt`:**

```typescript
function buildSystemPrompt(
  durationMs?: number,
  language?: string,
  momentTheme?: string,
): string {
  // ... existing logic to build base prompt ...

  const themeInstruction = momentTheme
    ? `\n- If relevant to the theme, give higher priority to segments matching: "${sanitizeMomentTheme(momentTheme)}".`
    : '';

  return `${basePrompt}${themeInstruction}`;
}
```

**Fungsi sanitasi:**

```typescript
const MAX_THEME_LENGTH = 200;

function sanitizeMomentTheme(raw: string): string {
  // Remove control characters (ASCII < 0x20, except tab)
  // then truncate to MAX_THEME_LENGTH
  return raw
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, MAX_THEME_LENGTH)
    .trim();
}
```

**Propagasi ke kedua LLM path:**

`buildSystemPrompt` dipanggil sekali dan hasilnya dioper ke `callGemini` dan `callOllamaChat` — tidak perlu perubahan di masing-masing caller selain meneruskan `momentTheme` ke `buildSystemPrompt`.

```typescript
const systemPrompt = buildSystemPrompt(durationMs, language, momentTheme);
```

---

## Data Models

Tidak ada perubahan skema database. `momentTheme` adalah parameter runtime per-request — tidak perlu dipersist. Setiap kali user menjalankan analisis, ia bisa mengganti atau mengosongkan tema tanpa memengaruhi data yang tersimpan.

---

### Interface Summary

#### `HookListPanelProps` (updated)

```typescript
interface HookListPanelProps {
  hooks: Hook[];
  projectId: string;
  projectDurationMs: number;
  selectedHookId: string | null;
  analyzing: boolean;
  ollamaError: boolean;
  onHookSelected: (id: string) => void;
  onHookDismissed: (id: string) => void;
  onRefresh: () => void;
  onRunAnalysis: (momentTheme: string) => void;  // NEW
}
```

#### `IpcServices.startAnalyze` (updated)

```typescript
startAnalyze: (projectId: string, momentTheme?: string) => Promise<unknown[]>;
```

#### `ipc.analyze.start` (updated)

```typescript
start(projectId: string, momentTheme?: string): Promise<Hook[]>
```

#### `Analyzer.detectHooks` (updated)

```typescript
async detectHooks(
  projectId: string,
  transcript: Transcript,
  modelName?: string,
  durationMs?: number,
  geminiApiKey?: string,
  serviceAccountPath?: string,
  momentTheme?: string,
): Promise<Hook[]>
```

---

## Error Handling

| Kondisi | Penanganan |
|---|---|
| `momentTheme` > 200 karakter | `sanitizeMomentTheme` memotong ke 200 karakter sebelum diinjeksikan ke prompt |
| `momentTheme` mengandung karakter kontrol | `sanitizeMomentTheme` menghapus karakter `\x00–\x1F` (kecuali tab) dan `\x7F` |
| `momentTheme` kosong/whitespace saja | `trim()` menghasilkan string kosong → tidak ada instruksi tema yang diinjeksikan |
| LLM mengabaikan instruksi tema | Perilaku normal; `momentTheme` hanya soft preference, bukan filter wajib |
| `onRunAnalysis` tidak dipanggil dari panel | Tombol "Run Analysis" di TopBar memanggil `handleRunAnalysis('')` — backward-compatible |

---

## Testing Strategy

### Unit Tests (Example-based)

Focus on specific behaviors that are fixed and don't vary meaningfully with input:

- **1.1** Render `HookListPanel` → assert theme input element exists in header
- **1.2** On mount, theme input value is `''`
- **1.3** Theme input has correct placeholder text
- **1.8** When `analyzing=true`, theme input has `disabled` attribute
- **2.1** `handleRunAnalysis(theme)` wires correctly from `HookListPanel` callback to `ProjectViewClient`
- **4.3** `buildSystemPrompt(durationMs, language)` without `momentTheme` produces output identical to pre-feature baseline
- **4.5** Both Gemini and Ollama paths call `buildSystemPrompt` with the same `momentTheme` argument

### Property Tests (Universal)

Run minimum 100 iterations each. Use a property-based testing library (e.g., `fast-check` for TypeScript).

| Property | Generator | What varies |
|---|---|---|
| P1 — Input state reflects typed value | `fc.string()` | Any string the user could type |
| P2 — Clear button visibility invariant | `fc.string()`, `fc.constant('')` | Empty vs non-empty momentTheme |
| P3 — Clear button resets state | `fc.string({ minLength: 1 })` | Any non-empty starting value |
| P4 — momentTheme round-trip through callback | `fc.string()` | Any theme value |
| P5 — Non-empty momentTheme forwarded to IPC | `fc.string({ minLength: 1 }).filter(s => s.trim() !== '')` | Any non-whitespace theme |
| P6 — Empty momentTheme omitted from IPC | `fc.constant('')`, `fc.string().map(s => s.trim()).filter(s => s === '')` | Empty/whitespace inputs |
| P7 — Handler forwards momentTheme to service | `fc.string({ minLength: 1 })` | Any non-empty theme string |
| P8 — Theme soft preference injected into prompt | `fc.string({ minLength: 1 }).filter(s => s.trim() !== '')` | Any valid theme |
| P9 — Absent momentTheme produces unchanged prompt | N/A (single example) | — |
| P10 — Sanitization length truncation | `fc.string({ minLength: 201, maxLength: 1000 })` | Strings exceeding 200 chars |
| P11 — Sanitization control character removal | `fc.string()` with injected control chars | Strings with control characters |

### Tag Format

Each property test must be tagged:

```
Feature: hook-moment-theme, Property {N}: {property_title}
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Input state reflects typed value

*For any* string typed into the momentTheme input, the controlled input value in `HookListPanel` state SHALL equal that string.

**Validates: Requirements 1.4**

---

### Property 2: Clear button visibility invariant

*For any* non-empty momentTheme string, the clear button SHALL be rendered. *For any* empty momentTheme string (including `''`), the clear button SHALL NOT be rendered.

**Validates: Requirements 1.5**

---

### Property 3: Clear button resets state

*For any* non-empty momentTheme string currently in state, clicking the clear button SHALL result in momentTheme state becoming the empty string `''`.

**Validates: Requirements 1.6**

---

### Property 4: momentTheme round-trip through callback

*For any* string value of momentTheme in `HookListPanel` state, triggering analysis SHALL invoke `onRunAnalysis` with exactly that string value — no mutation, truncation, or loss in transit through the React callback.

**Validates: Requirements 1.7**

---

### Property 5: Non-empty momentTheme forwarded to IPC

*For any* non-empty, non-whitespace-only momentTheme string, `ipc.analyze.start(projectId, momentTheme)` SHALL invoke `window.electron.invoke('analyze:start', projectId, momentTheme)` with that exact string as the second argument.

**Validates: Requirements 2.2, 2.5**

---

### Property 6: Empty momentTheme omitted from IPC call

*For any* call to `ipc.analyze.start(projectId)` without momentTheme, or with an empty/whitespace-only string, `window.electron.invoke` SHALL be called with only `projectId` — no second argument passed to the channel.

**Validates: Requirements 2.3, 2.6**

---

### Property 7: Handler forwards momentTheme to service

*For any* non-empty momentTheme string received by the `analyze:start` IPC handler, `services.startAnalyze` SHALL be called with both `projectId` and `momentTheme` as arguments.

**Validates: Requirements 3.2**

---

### Property 8: Theme soft preference injected into system prompt

*For any* non-empty, sanitized momentTheme string, `buildSystemPrompt(durationMs, language, momentTheme)` SHALL produce a string that contains the theme value and uses soft-preference wording (e.g., "give higher priority") rather than exclusionary or mandatory language.

**Validates: Requirements 4.2, 4.4**

---

### Property 9: Absent momentTheme produces unchanged prompt

*For any* call to `buildSystemPrompt(durationMs, language)` without momentTheme (or with `undefined`), the output SHALL be identical to the output produced before this feature was added — no additional lines or characters.

**Validates: Requirements 4.3**

---

### Property 10: momentTheme sanitization — length truncation

*For any* string longer than 200 characters, `sanitizeMomentTheme` SHALL return a string of length ≤ 200 characters, and the first 200 characters of the input (after control-character removal) SHALL be preserved.

**Validates: Requirements 4.6**

---

### Property 11: momentTheme sanitization — control character removal

*For any* string containing ASCII control characters (codepoints `\x00–\x08`, `\x0B`, `\x0C`, `\x0E–\x1F`, `\x7F`), `sanitizeMomentTheme` SHALL return a string containing none of those characters.

**Validates: Requirements 4.6**
