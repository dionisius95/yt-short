# Implementation Plan: UI Screens

## Overview

Implement the complete renderer-side user interface for the AI Shorts Generator desktop application. All five screens (Dashboard, Import, Project View, Export Queue, Settings) plus shared layout components are built using Next.js 14 App Router, React 18, Tailwind CSS, shadcn/ui, and TypeScript. All backend communication goes through the existing typed IPC bridge in `renderer/lib/ipc-client.ts`. Tasks are ordered to build shared infrastructure first, then screens from simplest to most complex, wiring everything together at the end.

---

## Tasks

- [x] 1. Shared utilities and design-system primitives
  - [x] 1.1 Create `renderer/lib/formatters.ts` with `formatRelativeTime`, `formatDuration`, `formatMs`, and `formatFileSize`
    - `formatRelativeTime(ms)` → "3 days ago" using `Intl.RelativeTimeFormat`
    - `formatDuration(ms)` and `formatMs(ms)` → "MM:SS" strings
    - `formatFileSize(bytes)` → "3.2 MiB"
    - _Requirements: 2.5, 5.2, 3.7_
  - [x] 1.2 Write property tests for formatter utilities
    - **Property 10: Hook Card Fields Completeness** — `formatMs` output appears in rendered `HookCard`
    - **Property 7: Download Progress Card Fields** — `formatFileSize` / `formatMs` output appears in rendered `DownloadProgressCard`
    - **Validates: Requirements 5.2, 3.7**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 1.3 Create `renderer/lib/urlValidator.ts` — renderer-side YouTube URL validator
    - Mirror `electron/utils/urlValidator.ts` logic for the three URL patterns
    - Export `validateYouTubeUrl(url: string): { valid: boolean; videoId: string | null }`
    - _Requirements: 3.2, 3.3, 3.4_
  - [x] 1.4 Write property test for YouTube URL validation
    - **Property 6: YouTube URL Validation** — valid patterns return `{ valid: true }`, all others return `{ valid: false }`
    - **Validates: Requirements 3.2, 3.3, 3.4**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 1.5 Create `renderer/hooks/useIpcEvent.ts` — generic IPC push-event subscription hook
    - Signature: `useIpcEvent<T>(channel, handler, deps?): void`
    - Wraps `window.electron.on()` in `useEffect`, stores unsubscribe, calls it on cleanup
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
  - [x] 1.6 Write unit test for `useIpcEvent` cleanup
    - Mock `window.electron.on` returning a spy unsubscribe function
    - Assert unsubscribe is called when component unmounts
    - File: `tests/unit/useIpcEvent.test.ts`
    - _Requirements: 9.6_
  - [x] 1.7 Create `renderer/hooks/useToast.ts` and `renderer/components/ui/Toast.tsx`
    - `useToast` manages `Toast[]` state; success toasts auto-dismiss after 3 s; error toasts persist
    - `Toast.tsx` renders a fixed-position stack of toast notifications with dismiss button
    - _Requirements: 11.6, 11.7_
  - [x] 1.8 Create `renderer/hooks/useConfirm.tsx` and `renderer/components/ui/ConfirmDialog.tsx`
    - `useConfirm` returns `{ confirm, ConfirmDialogNode }` — opens a modal and resolves a promise on confirm/cancel
    - `ConfirmDialog.tsx` traps keyboard focus while open, returns focus to trigger on close
    - Uses `<dialog>` or shadcn/ui `Dialog` primitive
    - _Requirements: 11.8, 12.8_

- [x] 2. Shared UI primitives
  - [x] 2.1 Create `renderer/components/ui/StatusBadge.tsx`
    - Accepts `variant: BadgeVariant` and optional `label` override
    - Color mapping: `complete` → `#22C55E`, `failed` → `#EF4444`, others → `#6366F1` or muted
    - Includes `role="status"` and `aria-label` for screen readers
    - _Requirements: 2.6, 7.3, 12.5_
  - [x] 2.2 Write property test for `StatusBadge`
    - **Property 5: Status Badge Correctness** — every `BadgeVariant` produces a non-empty label and correct color class
    - **Validates: Requirements 2.6**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 2.3 Create `renderer/components/ui/ProgressBar.tsx`
    - Accepts `value: number` (0–100), renders a filled bar using accent color
    - Includes `role="progressbar"`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`
    - _Requirements: 3.7, 7.4, 9.3_
  - [x] 2.4 Create `renderer/components/ui/SegmentedControl.tsx`
    - Generic multi-option selector; accepts `options: { value: string; label: string }[]`, `value`, `onChange`
    - Keyboard-navigable with arrow keys; active option styled with accent color
    - _Requirements: 3.5, 8.3, 6.4, 6.5_

- [x] 3. Shared layout — AppShell, Sidebar, TopBar
  - [x] 3.1 Create `renderer/components/layout/Sidebar.tsx`
    - Renders vertical nav with links to `/`, `/import`, `/settings` using `next/link`
    - Uses `usePathname()` to highlight the active link with `bg-accent/10 text-accent` and left border
    - Displays "AI Shorts Generator" wordmark at top
    - All links have `aria-label` and are keyboard-navigable
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.7_
  - [x] 3.2 Write property test for Sidebar active route highlighting
    - **Property 1: Active Route Highlighting** — for any route in `['/', '/import', '/settings']`, exactly one link has active styling
    - **Validates: Requirements 1.2**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 3.3 Create `renderer/components/layout/TopBar.tsx`
    - Accepts `title: string` and optional `actions` slot
    - Renders within Electron frameless window area (`-webkit-app-region: drag`, interactive children `no-drag`)
    - _Requirements: 1.4, 1.8_
  - [x] 3.4 Write property test for TopBar title display
    - **Property 2: TopBar Title Display** — any non-empty title string appears in rendered output
    - **Validates: Requirements 1.4**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 3.5 Create `renderer/components/layout/AppShell.tsx` and update `renderer/app/layout.tsx`
    - `AppShell` uses CSS Grid `grid-cols-[240px_1fr]` with top row for TopBar
    - Update `layout.tsx` to wrap `{children}` with `<AppShell>`; each page passes its title via a layout context or prop
    - Sidebar and TopBar remain visible during all navigation transitions
    - _Requirements: 1.6, 10.6_

- [x] 4. Dashboard screen
  - [x] 4.1 Create `renderer/components/dashboard/ProjectCardSkeleton.tsx` and `ProjectCard.tsx`
    - `ProjectCardSkeleton`: animated pulse placeholder matching card dimensions
    - `ProjectCard`: displays thumbnail (or `<FilmIcon>` placeholder), title, clip count, relative date via `formatRelativeTime`, `<StatusBadge>`, delete icon button
    - Delete button opens `<ConfirmDialog>` before invoking `ipc.projects.delete()`
    - Card and delete button have `aria-label`; card is focusable and activatable via Enter
    - _Requirements: 2.5, 2.6, 2.8, 2.9, 12.1, 12.3_
  - [x] 4.2 Write property test for `ProjectCard` fields completeness
    - **Property 4: Project Card Fields Completeness** — any `ProjectDashboardItem` produces output with title, clip count, date string, and status badge
    - **Validates: Requirements 2.5**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 4.3 Create `renderer/components/dashboard/ProjectGrid.tsx`
    - Responsive grid layout; accepts `projects: ProjectDashboardItem[]`, `onDelete`, `onSelect`
    - Renders `<ProjectCardSkeleton>` array while loading
    - Renders empty state (large URL input + label) when array is empty
    - _Requirements: 2.1, 2.2, 2.3, 2.12_
  - [x] 4.4 Write property test for Dashboard card count
    - **Property 3: Dashboard Card Count Matches Data** — any `ProjectDashboardItem[]` produces exactly that many cards
    - **Validates: Requirements 2.1**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 4.5 Implement `renderer/app/page.tsx` — Dashboard page
    - Invoke `ipc.projects.list()` on mount; show skeleton while loading, error + Retry on failure
    - Empty-state URL input navigates to `/import?url=<value>` on submit
    - "New Import" button in TopBar actions slot navigates to `/import`
    - Clicking a card navigates to `/project/[id]`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7, 2.10, 2.11_

- [x] 5. Import screen
  - [x] 5.1 Create `renderer/components/import/ImportForm.tsx`
    - Full-width URL input with placeholder "Paste YouTube URL here…"; auto-focuses on mount
    - Validates input with `validateYouTubeUrl` on every change; shows green checkmark or error message inline
    - Quality `<SegmentedControl>` with options 1080p / 720p / 480p / 360p, defaulting to 1080p
    - Submit button enabled only when URL is valid and no download is in progress
    - Reads `initialUrl` prop (from Dashboard empty-state navigation)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.12, 3.13_
  - [x] 5.2 Create `renderer/components/import/DownloadProgressCard.tsx`
    - Displays `<ProgressBar>`, speed string, and ETA string from `DownloadProgress`
    - "Cancel" button invokes `ipc.download.cancel()` and resets form state
    - _Requirements: 3.7, 3.8, 3.9_
  - [x] 5.3 Write property test for `DownloadProgressCard` fields
    - **Property 7: Download Progress Card Fields** — any `DownloadProgress` object produces output containing percent, speed, and eta
    - **Validates: Requirements 3.7**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 5.4 Implement `renderer/app/import/page.tsx` — Import screen page
    - Renders `<ImportForm>` and conditionally `<DownloadProgressCard>`
    - On submit: invoke `ipc.download.start()`; subscribe to `download:progress` via `useIpcEvent`; navigate to `/project/[id]` on completion
    - On error: display inline error, re-enable form
    - Reads `?url=` query param to pre-populate `initialUrl`
    - _Requirements: 3.6, 3.8, 3.10, 3.11, 9.1_

- [ ] 6. Checkpoint — layout and navigation baseline
  - Ensure all tests pass, ask the user if questions arise.
  - Verify Sidebar highlights correctly on each route, TopBar renders titles, AppShell grid layout is correct, Dashboard loads and displays cards, Import form validates URLs.

- [x] 7. Project View — data hooks and transcript panel
  - [x] 7.1 Fully implement `renderer/hooks/useProject.ts`
    - Extend existing stub: expose `hooks`, `transcript`, and `clips` alongside `project`
    - Invoke `ipc.hooks.list()` and `ipc.projects.get()` in parallel on mount
    - _Requirements: 4.1, 5.1_
  - [x] 7.2 Create `renderer/components/project/TranscriptWord.tsx`
    - Display span toggles to `<input>` on double-click; pre-populated with current word text
    - Enter / blur confirms and calls `ipc.hooks.update()`; Escape cancels without IPC call
    - Words with `confidence < 0.6` get `text-text-secondary italic` classes
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6_
  - [x] 7.3 Write property test for `TranscriptWord` confidence styling
    - **Property 8: Transcript Word Confidence Styling** — muted italic applied iff `confidence < 0.6`
    - **Validates: Requirements 4.3**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 7.4 Create `renderer/components/project/TranscriptPanel.tsx`
    - Scrollable container rendering inline `<TranscriptWord>` elements
    - Shows transcription progress bar (from `transcribe:progress` events via `useIpcEvent`) while in progress
    - Shows "Transcription pending" placeholder with "Start Transcription" button when no transcript exists
    - _Requirements: 4.1, 4.2, 4.7, 4.8, 9.2_

- [x] 8. Project View — hook list panel
  - [x] 8.1 Create `renderer/components/project/TimelineScrubber.tsx`
    - Custom dual-handle range slider using pointer event handlers on a `<div>`
    - `onChange` updates local preview state; `onChangeCommitted` (pointer up) fires IPC call
    - Handles are keyboard-accessible (arrow keys adjust by 1 s increments)
    - _Requirements: 5.5, 5.6_
  - [x] 8.2 Create `renderer/components/project/HookCard.tsx`
    - Displays summary, viral score badge (accent color), `formatMs(startMs)`, `formatMs(endMs)`, duration in seconds
    - Contains `<TimelineScrubber>`, "Generate Clip" button, "Dismiss" button
    - "Dismiss" invokes `ipc.hooks.dismiss()` and removes card from list without reload
    - "Generate Clip" invokes `ipc.clips.generate()` then navigates to Export Queue
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6_
  - [x] 8.3 Write property test for `HookCard` fields completeness
    - **Property 10: Hook Card Fields Completeness** — any `Hook` produces output with summary, viral score, formatted start/end times, and duration
    - **Validates: Requirements 5.2**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 8.4 Create `renderer/components/project/HookListPanel.tsx`
    - Renders non-dismissed hooks sorted by `viralScore` descending as stacked `<HookCard>` components
    - "Generate All Clips" button above list invokes `ipc.clips.generate()` for all non-dismissed hooks
    - Loading state (spinner + "Analyzing transcript for hooks…") while analysis runs
    - Empty state: "No hooks detected. Try re-running analysis."
    - Ollama error state: "Ollama is not running…" with "Retry" button and link to Settings
    - _Requirements: 5.1, 5.7, 5.8, 5.9, 5.10_
  - [x] 8.5 Write property test for `HookListPanel` filtering and ordering
    - **Property 9: Hook List Filtering and Ordering** — any `Hook[]` with mixed `dismissed` flags renders only non-dismissed hooks in descending `viralScore` order
    - **Validates: Requirements 5.1**
    - File: `tests/property/uiScreens.property.test.ts`

- [x] 9. Project View — clip preview panel
  - [x] 9.1 Create `renderer/components/project/ClipPreviewPanel.tsx`
    - 9:16 aspect ratio container (`aspect-[9/16]`) with HTML5 `<video>` element
    - Placeholder message when no hook selected; loading state with `<ProgressBar>` while clip processes (subscribes to `clip:progress` via `useIpcEvent`)
    - Subtitle style `<SegmentedControl>` (Bold White / Gradient Pop / Minimal Clean) defaulting to `AppSettings.defaultSubtitleStyle`
    - Subtitle position `<SegmentedControl>` (Lower Third / Upper Third / Center) defaulting to `AppSettings.defaultSubtitlePosition`
    - "Auto Zoom" toggle defaulting to enabled
    - Changing any option invokes `ipc.clips.generate()` with updated options
    - Error state shows `clip.errorMessage` and "Retry" button
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_
  - [x] 9.2 Write property test for `ClipPreviewPanel` subtitle style default
    - **Property 11: Clip Preview Subtitle Style Default** — any `SubtitleStyle` in `AppSettings.defaultSubtitleStyle` initializes the selector to that value
    - **Validates: Requirements 6.4**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 9.3 Implement `renderer/app/project/[id]/page.tsx` — Project View page
    - Three-column layout: `<TranscriptPanel>` (left), `<HookListPanel>` (center), `<ClipPreviewPanel>` (right)
    - Loads project via `useProject`; shows "Project not found" error screen with back link if `project:get` rejects
    - Passes `selectedHookId` state down to `HookListPanel` and `ClipPreviewPanel`
    - Subscribes to `transcribe:progress` and `clip:progress` via `useIpcEvent`; discards events for non-matching IDs
    - _Requirements: 4.1, 9.2, 9.3, 9.7, 10.4, 10.5_

- [x] 10. Export Queue screen
  - [x] 10.1 Create `renderer/components/export/ClipItem.tsx`
    - Displays thumbnail placeholder, hook summary, `<StatusBadge>`, action buttons (Preview, Upload to YouTube, Remove)
    - When `status === 'processing'`: shows `<ProgressBar>` and ETA updated via `clip:progress` events
    - "Preview" invokes `ipc.shell.openPath(clip.outputPath)`
    - "Remove" opens `<ConfirmDialog>` then invokes `ipc.clips.delete()`
    - "Retry" (when `status === 'failed'`) invokes `ipc.clips.generate()` for the hook
    - All icon-only buttons have `aria-label`
    - _Requirements: 7.3, 7.4, 7.6, 7.7, 7.8, 7.9, 12.3_
  - [x] 10.2 Write property test for `ClipItem` fields completeness
    - **Property 12: Clip Item Fields Completeness** — any `Clip` produces output with status badge, hook summary, and Preview/Upload/Remove buttons
    - **Validates: Requirements 7.3**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 10.3 Write property test for `ClipItem` progress bar updates
    - **Property 13: Clip Progress Bar Updates** — any progress value 0–100 emitted via `clip:progress` for a matching `clipId` causes the progress bar to reflect that value
    - **Validates: Requirements 7.4**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 10.4 Create `renderer/components/export/ExportSummaryBanner.tsx`
    - Displays "N complete · M failed" summary banner when all clips are `complete` or `failed`
    - _Requirements: 7.12_
  - [x] 10.5 Implement `renderer/app/project/[id]/clips/page.tsx` — Export Queue page
    - Invokes `ipc.clips.list(projectId)` on mount; shows skeleton while loading
    - Subscribes to `clip:progress` and `export:progress` via `useIpcEvent` on mount; unsubscribes on unmount
    - Discards events for non-matching `clipId`
    - "Start Export" button invokes `ipc.export.start()` for all pending clips
    - Status summary row in TopBar: "N complete · M processing · K pending"
    - Empty state: "No clips yet…" with link to Dashboard
    - Shows `<ExportSummaryBanner>` when all clips are terminal
    - _Requirements: 7.1, 7.2, 7.5, 7.10, 7.11, 7.12, 7.13, 9.3, 9.4, 9.7_

- [x] 11. Settings screen
  - [x] 11.1 Create `renderer/components/settings/SettingsForm.tsx`
    - Controlled form with sections: Directories, AI Models, Subtitle Defaults, Video
    - "Browse" buttons invoke `ipc.dialog.openDirectory()` and populate the corresponding input
    - "Save" button invokes `ipc.settings.set()` with changed values; shows success toast on success, inline error on failure
    - YouTube Account section shows auth status from `ipc.upload.getAuthStatus()` and Connect/Disconnect button
    - _Requirements: 8.1, 8.3, 8.4, 8.5, 8.6, 8.12_
  - [x] 11.2 Write property test for `SettingsForm` population
    - **Property 14: Settings Form Population** — any `AppSettings` object populates every form field with the corresponding value
    - **Validates: Requirements 8.1**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 11.3 Create `renderer/components/settings/DependencyPanel.tsx`
    - Renders five status rows (yt-dlp, FFmpeg, Whisper.cpp, Ollama, MediaPipe) with green/red indicator icons and version strings
    - Warning banner listing missing tools when any `detected: false`
    - "Re-check" button re-invokes `ipc.deps.check()`
    - _Requirements: 8.7, 8.8, 8.9, 8.10, 8.11_
  - [x] 11.4 Write property test for `DependencyPanel` completeness
    - **Property 15: Dependency Panel Completeness** — any `DepsCheckResult` produces exactly five rows with matching `detected` indicators
    - **Validates: Requirements 8.7**
    - File: `tests/property/uiScreens.property.test.ts`
  - [x] 11.5 Implement `renderer/app/settings/page.tsx` — Settings page
    - Two-column layout: `<SettingsForm>` on left, `<DependencyPanel>` on right
    - Invokes `ipc.settings.get()` and `ipc.deps.check()` in parallel on mount
    - _Requirements: 8.1, 8.2, 8.9_

- [ ] 12. IPC event handling and error states — cross-cutting wiring
  - [ ] 12.1 Audit all screens for `useIpcEvent` usage — ensure every `window.electron.on` subscription is managed through `useIpcEvent` and cleaned up on unmount
    - Verify Import, Project View, and Export Queue screens all unsubscribe correctly
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
  - [ ] 12.2 Write property test for IPC event listener cleanup
    - **Property 16: IPC Event Listener Cleanup** — unmounting any component that uses `useIpcEvent` calls the unsubscribe function
    - **Validates: Requirements 9.6**
    - File: `tests/property/uiScreens.property.test.ts`
  - [ ] 12.3 Write property test for mismatched event discarding
    - **Property 17: Mismatched Event Discarding** — a `clip:progress` event with a non-matching `clipId` leaves component state unchanged
    - **Validates: Requirements 9.7**
    - File: `tests/property/uiScreens.property.test.ts`
  - [ ] 12.4 Implement error code handling in all screens
    - `OLLAMA_UNAVAILABLE` → "Ollama is not running…" message with link to `/settings`
    - `DEPENDENCY_MISSING` → "A required tool is missing…" with link to `/settings`
    - `INVALID_URL` → inline below URL input on Import screen
    - Generic IPC rejection → inline error with Retry button
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  - [ ] 12.5 Write property test for IPC error display
    - **Property 18: IPC Error Display** — any IPC channel rejection causes the component to display a non-empty error message string
    - **Validates: Requirements 11.1**
    - File: `tests/property/uiScreens.property.test.ts`

- [ ] 13. Accessibility and design system compliance
  - [ ] 13.1 Audit all interactive elements for keyboard navigability and focus rings
    - Ensure Tab order is logical on all five screens
    - Apply `focus-visible:ring-2 focus-visible:ring-accent` to all interactive elements
    - _Requirements: 12.1, 12.2_
  - [ ] 13.2 Add `aria-label` / `aria-labelledby` to all icon-only buttons and form inputs across all components
    - Verify `<nav>`, `<main>`, `<section>`, `<button>`, `<input>` semantic elements are used throughout
    - _Requirements: 12.3, 12.4, 12.7_
  - [ ] 13.3 Add `aria-live="polite"` or `role="status"` to all status badges and progress indicators
    - Verify `<ConfirmDialog>` traps focus and restores it on close
    - _Requirements: 12.5, 12.8_
  - [ ] 13.4 Verify design token usage across all components
    - Confirm color tokens (`#0A0A0A`, `#111111`, `#1E1E1E`, `#F5F5F5`, `#888888`, `#6366F1`, `#EF4444`, `#22C55E`) are applied via Tailwind config classes only
    - Confirm border radii (8px cards, 6px inputs, 4px badges), 150ms hover transitions, 300ms page transitions, Inter + JetBrains Mono fonts
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

- [ ] 14. Final checkpoint — full integration
  - Ensure all tests pass, ask the user if questions arise.
  - Verify end-to-end navigation flow: Dashboard → Import → Project View → Export Queue → Settings.
  - Confirm all IPC subscriptions are cleaned up, all error states display correctly, and all property tests in `tests/property/uiScreens.property.test.ts` pass.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- All property tests go in a single file: `tests/property/uiScreens.property.test.ts`
- All unit tests go in `tests/unit/` with descriptive filenames per component
- Each task references specific requirements for traceability
- The design document's 18 correctness properties are each covered by a dedicated `*` sub-task
- `useIpcEvent` is the single point of truth for all `window.electron.on` subscriptions — never call it directly in components
- The `ipc` client in `renderer/lib/ipc-client.ts` is already fully typed — use it exclusively, never call `window.electron.invoke` directly
- shadcn/ui primitives (Dialog, Button, Input, etc.) should be installed via `npx shadcn-ui@latest add <component>` before use

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.5", "1.7", "1.8"] },
    { "id": 1, "tasks": ["1.2", "1.4", "1.6", "2.1", "2.3", "2.4"] },
    { "id": 2, "tasks": ["2.2", "3.1", "3.3"] },
    { "id": 3, "tasks": ["3.2", "3.4", "3.5"] },
    { "id": 4, "tasks": ["4.1", "4.3", "5.1", "5.2"] },
    { "id": 5, "tasks": ["4.2", "4.4", "4.5", "5.3", "5.4", "7.1"] },
    { "id": 6, "tasks": ["7.2", "8.1", "9.1", "10.1", "10.4", "11.1", "11.3"] },
    { "id": 7, "tasks": ["7.3", "7.4", "8.2", "8.4", "9.2", "10.2", "10.3", "11.2", "11.4"] },
    { "id": 8, "tasks": ["8.3", "8.5", "9.3", "10.5", "11.5"] },
    { "id": 9, "tasks": ["12.1", "12.4", "13.1", "13.2", "13.3", "13.4"] },
    { "id": 10, "tasks": ["12.2", "12.3", "12.5"] }
  ]
}
```
