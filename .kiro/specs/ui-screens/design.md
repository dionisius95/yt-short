# Design Document — UI Screens

## Overview

This document describes the technical design for the complete renderer-side user interface of the AI Shorts Generator desktop application. The Electron main process, database layer, and IPC handlers are already fully implemented. This feature replaces all placeholder pages with five functional screens — Dashboard, Import, Project View, Export Queue, and Settings — plus two shared layout components (Sidebar and TopBar).

All renderer↔main communication goes through the typed IPC bridge (`window.electron.invoke` / `window.electron.on`) via the `ipc` client in `renderer/lib/ipc-client.ts`. No direct file system or database access occurs in the renderer.

The stack is: **Next.js 14 App Router** (static export mode for Electron), **React 18**, **Tailwind CSS**, **shadcn/ui** component primitives, and **TypeScript**. The design system is dark-mode only with tokens already defined in `tailwind.config.ts` and `globals.css`.

---

## Architecture

### High-Level Structure

```
renderer/
├── app/
│   ├── layout.tsx                  # Root layout — wraps all pages with AppShell
│   ├── page.tsx                    # Dashboard (/)
│   ├── import/
│   │   └── page.tsx                # Import screen (/import)
│   ├── project/
│   │   └── [id]/
│   │       ├── page.tsx            # Project View (/project/[id])
│   │       └── clips/
│   │           └── page.tsx        # Export Queue (/project/[id]/clips)
│   └── settings/
│       └── page.tsx                # Settings (/settings)
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx            # Sidebar + TopBar wrapper
│   │   ├── Sidebar.tsx             # Left navigation panel
│   │   └── TopBar.tsx              # Top bar with page title
│   ├── dashboard/
│   │   ├── ProjectCard.tsx         # Single project card
│   │   ├── ProjectGrid.tsx         # Responsive card grid
│   │   └── ProjectCardSkeleton.tsx # Loading skeleton
│   ├── import/
│   │   ├── ImportForm.tsx          # URL input + quality selector
│   │   └── DownloadProgressCard.tsx
│   ├── project/
│   │   ├── TranscriptPanel.tsx     # Left panel — word-level transcript
│   │   ├── TranscriptWord.tsx      # Individual editable word
│   │   ├── HookListPanel.tsx       # Center panel — hook cards
│   │   ├── HookCard.tsx            # Single hook with scrubber
│   │   ├── TimelineScrubber.tsx    # Dual-handle range slider
│   │   └── ClipPreviewPanel.tsx    # Right panel — video player + options
│   ├── export/
│   │   ├── ClipItem.tsx            # Single clip row
│   │   └── ExportSummaryBanner.tsx
│   ├── settings/
│   │   ├── SettingsForm.tsx        # Grouped settings sections
│   │   └── DependencyPanel.tsx     # Dependency status rows
│   └── ui/
│       ├── StatusBadge.tsx         # Pipeline stage badge
│       ├── ProgressBar.tsx         # Reusable progress bar
│       ├── SegmentedControl.tsx    # Multi-option selector
│       ├── ConfirmDialog.tsx       # Destructive action confirmation
│       └── Toast.tsx               # Non-blocking notifications
├── hooks/
│   ├── useIpc.ts                   # Generic IPC invoke hook (exists)
│   ├── usePipelineStatus.ts        # Pipeline event subscription (exists)
│   ├── useProject.ts               # Project data hook (exists)
│   ├── useIpcEvent.ts              # Generic event subscription hook
│   ├── useToast.ts                 # Toast notification state
│   └── useConfirm.ts               # Confirmation dialog state
├── lib/
│   ├── ipc-client.ts               # Typed IPC wrappers (exists)
│   ├── utils.ts                    # cn() utility (exists)
│   ├── formatters.ts               # Date, duration, time formatters
│   └── urlValidator.ts             # YouTube URL validation (renderer copy)
└── styles/
    └── globals.css                 # Design tokens + base styles (exists)
```

### Data Flow

```
User Interaction
      │
      ▼
React Component (renderer)
      │  calls
      ▼
ipc-client.ts  ──invoke──▶  window.electron.invoke  ──IPC──▶  Main Process
                                                                    │
                                                               handlers.ts
                                                                    │
                                                              DB / Pipeline
                                                                    │
      React Component  ◀──state update──  useIpc hook  ◀──response──┘

Push Events (main → renderer):
Main Process  ──ipcMain.emit──▶  preload.ts  ──window.electron.on──▶  useIpcEvent hook  ──▶  Component state
```

### Routing

Next.js App Router with `output: 'export'` (static HTML for Electron). Client-side navigation via `next/navigation` `useRouter` and `Link`. No server components — all pages are `'use client'` since they require `window.electron`.

| Route | Component | Description |
|---|---|---|
| `/` | `app/page.tsx` | Dashboard |
| `/import` | `app/import/page.tsx` | Import screen |
| `/project/[id]` | `app/project/[id]/page.tsx` | Project View |
| `/project/[id]/clips` | `app/project/[id]/clips/page.tsx` | Export Queue |
| `/settings` | `app/settings/page.tsx` | Settings |

---

## Components and Interfaces

### AppShell

Wraps every page. Renders `<Sidebar>` on the left and `<TopBar>` at the top, with `<main>` occupying the remaining space. Uses CSS Grid: `grid-cols-[240px_1fr]` with a top row for the TopBar.

```tsx
interface AppShellProps {
  title: string;
  children: React.ReactNode;
}
```

The root `layout.tsx` renders `<AppShell>` around `{children}`. Each page passes its title via a `metadata` export or a layout-level context.

### Sidebar

```tsx
interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}
```

Uses `usePathname()` from `next/navigation` to determine the active route. Active link gets `bg-accent/10 text-accent` classes and a left border accent. All links use `<Link>` for SPA navigation. Renders the "AI Shorts Generator" wordmark at the top.

### TopBar

```tsx
interface TopBarProps {
  title: string;
  actions?: React.ReactNode;  // slot for "New Import" button etc.
}
```

Rendered inside the Electron frameless window area (`-webkit-app-region: drag` on the bar, `no-drag` on interactive elements).

### ProjectCard

```tsx
interface ProjectCardProps {
  project: ProjectDashboardItem;
  onDelete: (id: string) => void;
  onClick: (id: string) => void;
}
```

Displays thumbnail (or `<FilmIcon>` placeholder), title, clip count, relative date, and `<StatusBadge>`. Delete icon button triggers `<ConfirmDialog>`.

### ImportForm

```tsx
interface ImportFormProps {
  initialUrl?: string;  // pre-populated from Dashboard empty state
}
```

Manages local state: `url`, `quality`, `isDownloading`, `progress`. Calls `ipc.download.start()` on submit. Subscribes to `ipc.download.onProgress()` in a `useEffect`. Navigates to `/project/[id]` on completion.

### TranscriptPanel

```tsx
interface TranscriptPanelProps {
  projectId: string;
  transcript: Transcript | null;
  transcribeProgress: number | null;  // 0–100 while in progress
  onTriggerTranscription: () => void;
}
```

Renders words as inline `<TranscriptWord>` elements. Scrollable container with `overflow-y-auto`. Words with `confidence < 0.6` get `text-text-secondary italic` classes.

### TranscriptWord

```tsx
interface TranscriptWordProps {
  word: TranscriptWord;
  onUpdate: (wordId: string, newText: string) => void;
}
```

Toggles between display span and `<input>` on double-click. Escape cancels, Enter/blur confirms and calls `ipc.hooks.update()`.

### HookCard

```tsx
interface HookCardProps {
  hook: Hook;
  videoDurationMs: number;
  onGenerateClip: (hookId: string) => void;
  onDismiss: (hookId: string) => void;
  onUpdateTimes: (hookId: string, startMs: number, endMs: number) => void;
}
```

Displays summary, viral score badge, `MM:SS` formatted times, duration. Contains `<TimelineScrubber>` and "Generate Clip" / "Dismiss" buttons.

### TimelineScrubber

```tsx
interface TimelineScrubberProps {
  durationMs: number;
  startMs: number;
  endMs: number;
  onChange: (startMs: number, endMs: number) => void;
  onChangeCommitted: (startMs: number, endMs: number) => void;
}
```

A custom dual-handle range slider built on a `<div>` with pointer event handlers. `onChange` updates local preview state; `onChangeCommitted` (on pointer up) fires the IPC call.

### ClipPreviewPanel

```tsx
interface ClipPreviewPanelProps {
  projectId: string;
  selectedHookId: string | null;
  clip: Clip | null;
  clipProgress: number | null;
  settings: AppSettings;
  onRegenerateClip: (hookId: string, options: ClipOptions) => void;
}

interface ClipOptions {
  subtitleStyle: SubtitleStyle;
  subtitlePosition: SubtitlePosition;
  zoomEnabled: boolean;
}
```

9:16 aspect ratio container (`aspect-[9/16]`). HTML5 `<video>` element with `src` set to `clip.outputPath` when status is `complete`. Style/position selectors use `<SegmentedControl>`.

### ClipItem

```tsx
interface ClipItemProps {
  clip: Clip;
  hookSummary: string;
  progress: number | null;  // null when not processing
  onPreview: (clipId: string) => void;
  onUpload: (clipId: string) => void;
  onRemove: (clipId: string) => void;
  onRetry: (hookId: string) => void;
}
```

### SettingsForm

```tsx
interface SettingsFormProps {
  initialSettings: AppSettings;
  onSave: (settings: Partial<AppSettings>) => Promise<void>;
}
```

Uses `react-hook-form` pattern (or controlled state) with a single "Save" button. "Browse" buttons call `ipc.dialog.openDirectory()`.

### DependencyPanel

```tsx
interface DependencyPanelProps {
  result: DepsCheckResult | null;
  loading: boolean;
  onRecheck: () => void;
}
```

Renders five rows (yt-dlp, FFmpeg, Whisper.cpp, Ollama, MediaPipe). Green `<CheckCircleIcon>` or red `<XCircleIcon>` based on `detected`. Warning banner if any `detected: false`.

### StatusBadge

```tsx
type BadgeVariant = 'downloading' | 'transcribing' | 'analyzing' | 'processing' | 'complete' | 'failed' | 'pending';

interface StatusBadgeProps {
  variant: BadgeVariant;
  label?: string;  // override display text
}
```

Color mapping: `complete` → `success`, `failed` → `destructive`, others → `accent` or muted.

### useIpcEvent Hook

```tsx
function useIpcEvent<T>(
  channel: string,
  handler: (data: T) => void,
  deps?: React.DependencyList
): void
```

Wraps `window.electron.on()` in a `useEffect`, stores the unsubscribe function, and calls it on cleanup. Prevents memory leaks across all event-subscribing components.

### useToast Hook

```tsx
interface Toast {
  id: string;
  message: string;
  variant: 'success' | 'error' | 'info';
  autoDismiss: boolean;  // false for errors
}

function useToast(): {
  toasts: Toast[];
  showToast: (message: string, variant: Toast['variant'], autoDismiss?: boolean) => void;
  dismissToast: (id: string) => void;
}
```

Success toasts auto-dismiss after 3 seconds. Error toasts persist until manually dismissed.

---

## Data Models

The renderer uses the shared types from `shared/types.ts` directly. No additional data models are introduced in the renderer. Key types used per screen:

| Screen | Primary Types |
|---|---|
| Dashboard | `ProjectDashboardItem`, `PipelineStatus` |
| Import | `DownloadRequest`, `DownloadProgress` |
| Project View | `Project`, `Transcript`, `TranscriptWord`, `Hook`, `Clip`, `AppSettings` |
| Export Queue | `Clip`, `ExportProgress` |
| Settings | `AppSettings`, `DepsCheckResult` |

### Local UI State (not persisted)

Each screen manages ephemeral UI state in React component state or hooks:

- **Import**: `url: string`, `quality: Quality`, `isDownloading: boolean`, `downloadProgress: DownloadProgress | null`
- **Project View**: `selectedHookId: string | null`, `editingWordId: string | null`, `clipOptions: ClipOptions`
- **Export Queue**: `clipProgressMap: Map<string, number>` (clipId → percent)
- **Settings**: `formValues: Partial<AppSettings>`, `isDirty: boolean`

### Formatter Utilities (`renderer/lib/formatters.ts`)

```ts
formatRelativeTime(timestampMs: number): string   // "3 days ago"
formatDuration(ms: number): string                 // "MM:SS"
formatMs(ms: number): string                       // "01:23" for timestamps
formatFileSize(bytes: number): string              // "3.2 MiB"
```

### URL Validator (`renderer/lib/urlValidator.ts`)

A renderer-side copy of the YouTube URL validation logic (mirrors `electron/utils/urlValidator.ts`). Validates against three patterns:
- Standard: `https://www.youtube.com/watch?v=VIDEO_ID`
- Shortened: `https://youtu.be/VIDEO_ID`
- Embed: `https://www.youtube.com/embed/VIDEO_ID`

Returns `{ valid: boolean; videoId: string | null }`.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

This feature is a UI layer built on top of pure data-transformation functions (URL validation, formatting, filtering, sorting). PBT applies to those pure functions and to the data-binding contracts between components and their props. Infrastructure-level IPC wiring is covered by integration tests.

### Property 1: Active Route Highlighting

*For any* route path in the set `['/', '/import', '/settings']`, rendering the Sidebar with that path as the active route SHALL result in exactly one navigation link having the active accent styling, and it SHALL be the link whose `href` matches the active path.

**Validates: Requirements 1.2**

### Property 2: TopBar Title Display

*For any* non-empty page title string, rendering the TopBar with that title SHALL result in the title string appearing in the rendered output.

**Validates: Requirements 1.4**

### Property 3: Dashboard Card Count Matches Data

*For any* array of `ProjectDashboardItem` objects (including empty arrays), rendering the Dashboard with that array SHALL produce exactly as many project cards as there are items in the array.

**Validates: Requirements 2.1**

### Property 4: Project Card Fields Completeness

*For any* `ProjectDashboardItem`, rendering a `ProjectCard` with that item SHALL produce output containing the project title, the clip count, a human-readable date string, and a status badge element.

**Validates: Requirements 2.5**

### Property 5: Status Badge Correctness

*For any* valid `BadgeVariant` value, rendering a `StatusBadge` with that variant SHALL produce a visible label that is non-empty and SHALL apply a CSS class corresponding to the variant's semantic color (success, destructive, or accent).

**Validates: Requirements 2.6**

### Property 6: YouTube URL Validation

*For any* string that matches one of the three recognized YouTube URL patterns (standard `watch?v=`, shortened `youtu.be/`, embed `/embed/`), the `validateYouTubeUrl` function SHALL return `{ valid: true }`. *For any* string that does not match any recognized pattern, the function SHALL return `{ valid: false }`.

**Validates: Requirements 3.2, 3.3, 3.4**

### Property 7: Download Progress Card Fields

*For any* `DownloadProgress` object, rendering the `DownloadProgressCard` with that object SHALL produce output containing the `percent` value, the `speed` string, and the `eta` string.

**Validates: Requirements 3.7**

### Property 8: Transcript Word Confidence Styling

*For any* `TranscriptWord` object, rendering a `TranscriptWord` component SHALL apply muted italic styling if and only if `word.confidence < 0.6`.

**Validates: Requirements 4.3**

### Property 9: Hook List Filtering and Ordering

*For any* array of `Hook` objects with varying `dismissed` flags and `viralScore` values, rendering the `HookListPanel` SHALL display only non-dismissed hooks, and those hooks SHALL appear in descending order of `viralScore`.

**Validates: Requirements 5.1**

### Property 10: Hook Card Fields Completeness

*For any* `Hook` object, rendering a `HookCard` SHALL produce output containing the hook's `summary`, a viral score value, the `startMs` formatted as `MM:SS`, the `endMs` formatted as `MM:SS`, and the duration in seconds.

**Validates: Requirements 5.2**

### Property 11: Clip Preview Subtitle Style Default

*For any* `SubtitleStyle` value stored in `AppSettings.defaultSubtitleStyle`, rendering the `ClipPreviewPanel` with those settings SHALL initialize the subtitle style selector to that value.

**Validates: Requirements 6.4**

### Property 12: Clip Item Fields Completeness

*For any* `Clip` object, rendering a `ClipItem` SHALL produce output containing a status badge, the hook summary text, and action buttons for Preview, Upload, and Remove.

**Validates: Requirements 7.3**

### Property 13: Clip Progress Bar Updates

*For any* progress value between 0 and 100 inclusive, when a `clip:progress` event is emitted with a matching `clipId`, the `ClipItem` for that clip SHALL display a progress bar reflecting that value.

**Validates: Requirements 7.4**

### Property 14: Settings Form Population

*For any* `AppSettings` object, rendering the `SettingsForm` with that object SHALL populate every form field with the corresponding value from the settings object (download dir, export dir, whisper model, ollama model, subtitle style, subtitle position, video quality).

**Validates: Requirements 8.1**

### Property 15: Dependency Panel Completeness

*For any* `DepsCheckResult` object, rendering the `DependencyPanel` SHALL display exactly five status rows — one each for yt-dlp, FFmpeg, Whisper.cpp, Ollama, and MediaPipe — and each row's detected indicator SHALL match the `detected` boolean in the result.

**Validates: Requirements 8.7**

### Property 16: IPC Event Listener Cleanup

*For any* component that subscribes to an IPC push channel via `useIpcEvent`, unmounting that component SHALL invoke the unsubscribe function returned by `window.electron.on`, preventing memory leaks.

**Validates: Requirements 9.6**

### Property 17: Mismatched Event Discarding

*For any* IPC progress event whose `projectId` or `clipId` does not match the ID currently displayed by the component, the component's state SHALL remain unchanged after receiving that event.

**Validates: Requirements 9.7**

### Property 18: IPC Error Display

*For any* IPC channel that rejects with an error, the component invoking that channel SHALL display a non-empty error message string in the UI after the rejection.

**Validates: Requirements 11.1**

---

## Error Handling

### IPC Error Strategy

All IPC calls go through `useIpc` or direct `ipc.*` calls wrapped in try/catch. Errors are surfaced as component-local state, never swallowed silently.

```
IPC call rejects
      │
      ▼
catch block sets error state
      │
      ├─ AppErrorCode present?
      │       ├─ OLLAMA_UNAVAILABLE → show "Ollama is not running…" + link to Settings
      │       ├─ DEPENDENCY_MISSING → show "A required tool is missing…" + link to Settings
      │       ├─ INVALID_URL → show inline below URL input
      │       └─ other codes → show generic message with retry button
      │
      └─ No AppErrorCode → show error.message with retry button
```

### Error Display Rules

| Error Type | Display Location | Dismissible | Retry |
|---|---|---|---|
| IPC invoke failure | Inline in affected component | Yes (on retry) | Yes |
| Validation error | Below form field | Auto (on input change) | N/A |
| Destructive action | Confirmation dialog | Yes (cancel) | N/A |
| Non-critical success | Toast (auto-dismiss 3s) | Yes | N/A |
| Non-critical failure | Toast (persistent) | Yes (manual) | N/A |

### Not-Found Route

`/project/[id]` with a non-existent ID: `project:get` rejects → component renders a "Project not found" error screen with a `<Link href="/">Back to Dashboard</Link>`.

### Dependency Errors

If `deps:check` reveals missing tools, the Settings screen shows a warning banner. If a pipeline operation fails with `DEPENDENCY_MISSING`, the error message includes a direct link to `/settings`.

---

## Testing Strategy

### Dual Testing Approach

Unit/component tests cover specific examples, edge cases, and error conditions. Property-based tests verify universal properties across generated inputs. Both are necessary for comprehensive coverage.

### Property-Based Testing

**Library**: `fast-check` (already installed as a dev dependency at `3.21.0`).

**Runner**: Vitest (existing `tests/property/` workspace project).

**Configuration**: Minimum 100 iterations per property test (`numRuns: 100`).

**Tag format**: Each property test includes a comment:
```
// Feature: ui-screens, Property N: <property text>
```

**Test file location**: `tests/property/uiScreens.property.test.ts`

Each of the 18 correctness properties maps to a single `fc.assert(fc.property(...))` call. The pure functions under test (URL validator, formatters, filter/sort logic) are imported directly. Component-level properties use a lightweight render utility (React Testing Library or a custom render helper compatible with Vitest + jsdom).

**Arbitraries needed**:
- `fc.string()` — arbitrary URL strings for Property 6
- `fc.record({ word: fc.string(), confidence: fc.float({ min: 0, max: 1 }) })` — for Property 8
- `fc.array(hookArbitrary)` — for Property 9
- `fc.constantFrom('bold-white', 'gradient-pop', 'minimal-clean')` — for Property 11
- `fc.integer({ min: 0, max: 100 })` — for Property 13
- `fc.record(...)` matching `AppSettings` shape — for Property 14
- `fc.record(...)` matching `DepsCheckResult` shape — for Property 15

### Unit Tests

**Location**: `tests/unit/`

Focus areas:
- `formatters.ts`: `formatRelativeTime`, `formatDuration`, `formatMs` with specific examples and boundary values
- `urlValidator.ts` (renderer copy): specific valid/invalid URL examples
- `StatusBadge`: each variant renders the correct color class
- `ConfirmDialog`: focus trap behavior, cancel/confirm callbacks
- `useIpcEvent`: mock `window.electron.on`, verify cleanup is called on unmount
- `ImportForm`: submit disabled when URL invalid, enabled when valid
- `HookListPanel`: empty state when hooks array is empty, Ollama error state

### Integration Tests

**Location**: `tests/integration/`

These tests verify IPC wiring with a mocked `window.electron` object:
- Dashboard loads and renders project cards from mocked `project:list`
- Import screen navigates to project view after mocked `download:start` completes
- Settings screen populates from mocked `settings:get` and calls `settings:set` on save
- Dependency panel populates from mocked `deps:check`

### Accessibility Tests

Use `@axe-core/react` or `vitest-axe` in unit tests to catch WCAG violations automatically. Manual keyboard navigation testing for Tab order and focus trap in `ConfirmDialog`.

### Visual Regression (Optional)

Snapshot tests for `StatusBadge`, `ProjectCard`, and `HookCard` to catch unintended design token changes.
