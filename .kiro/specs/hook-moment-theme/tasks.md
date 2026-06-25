# Implementation Plan: hook-moment-theme

## Overview

Add an optional `momentTheme` parameter that flows from the `HookListPanel` UI input through `ProjectViewClient` → IPC Client → IPC Handler → `Analyzer.detectHooks()`, where it is injected into the LLM system prompt as a soft preference. All changes are backward-compatible — when `momentTheme` is empty or absent, behavior is identical to before.

## Tasks

- [ ] 1. Add `sanitizeMomentTheme` utility and update `Analyzer.detectHooks` signature
  - [ ] 1.1 Implement `sanitizeMomentTheme` helper and update `buildSystemPrompt` in `Analyzer.ts`
    - Add `sanitizeMomentTheme(raw: string): string` as a module-level function in `electron/pipeline/Analyzer.ts`
    - Strip ASCII control characters (`\x00–\x08`, `\x0B`, `\x0C`, `\x0E–\x1F`, `\x7F`) and truncate to 200 characters
    - Update `buildSystemPrompt(durationMs?, language?, momentTheme?)` to append the soft-preference line when `momentTheme` is provided and non-empty after sanitization
    - Soft-preference line format: `"\n- If relevant to the theme, give higher priority to segments matching: \"${sanitizeMomentTheme(momentTheme)}\"."`
    - When `momentTheme` is `undefined` or empty, output must be byte-for-byte identical to the pre-feature prompt
    - _Requirements: 4.3, 4.4, 4.6_

  - [ ] 1.2 Update `Analyzer.detectHooks` signature and both LLM paths
    - Add `momentTheme?: string` as the last parameter of `detectHooks`
    - Pass `momentTheme` to `buildSystemPrompt` in both the Gemini path and the Ollama path
    - Short-video bypass does not need `momentTheme` (it skips LLM entirely)
    - _Requirements: 4.1, 4.2, 4.5_

  - [ ]* 1.3 Write property tests for `sanitizeMomentTheme` and `buildSystemPrompt`
    - **Property 10: momentTheme sanitization — length truncation**
    - **Validates: Requirements 4.6**
    - **Property 11: momentTheme sanitization — control character removal**
    - **Validates: Requirements 4.6**
    - **Property 8: Theme soft preference injected into system prompt**
    - **Validates: Requirements 4.2, 4.4**
    - **Property 9: Absent momentTheme produces unchanged prompt**
    - **Validates: Requirements 4.3**
    - Use `fast-check`; tag each test: `Feature: hook-moment-theme, Property {N}: {title}`

- [ ] 2. Update IPC Handler and `IpcServices` interface
  - [ ] 2.1 Update `IpcServices.startAnalyze` signature and `ANALYZE_START` handler in `handlers.ts`
    - Change `startAnalyze` in the `IpcServices` interface to `(projectId: string, momentTheme?: string) => Promise<unknown[]>`
    - Update `ipcMain.handle(CHANNELS.ANALYZE_START, ...)` to destructure `(_event, projectId: string, momentTheme?: string)` and pass `momentTheme` to `services.startAnalyze(projectId, momentTheme)`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 2.2 Write property test for handler forwarding
    - **Property 7: Handler forwards momentTheme to service**
    - **Validates: Requirements 3.2**
    - Mock `services.startAnalyze` and assert it receives the exact `momentTheme` value passed to the handler

- [ ] 3. Update `ipc-client.ts` — typed IPC wrapper
  - [ ] 3.1 Update `ipc.analyze.start` to accept optional `momentTheme`
    - Change signature to `start(projectId: string, momentTheme?: string): Promise<Hook[]>`
    - When `momentTheme` is provided (truthy after `.trim()`): `invoke<Hook[]>('analyze:start', projectId, momentTheme)`
    - When `momentTheme` is absent or empty: `invoke<Hook[]>('analyze:start', projectId)` — no second argument
    - _Requirements: 2.4, 2.5, 2.6_

  - [ ]* 3.2 Write property tests for IPC client forwarding
    - **Property 5: Non-empty momentTheme forwarded to IPC**
    - **Validates: Requirements 2.2, 2.5**
    - **Property 6: Empty momentTheme omitted from IPC call**
    - **Validates: Requirements 2.3, 2.6**
    - Mock `window.electron.invoke` and assert call arguments

- [ ] 4. Checkpoint — Ensure all backend changes compile and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Update `HookListPanel.tsx` — add `momentTheme` input and `onRunAnalysis` prop
  - [ ] 5.1 Add `onRunAnalysis` prop and `momentTheme` local state to `HookListPanel`
    - Add `onRunAnalysis: (momentTheme: string) => void` to `HookListPanelProps`
    - Add `const [momentTheme, setMomentTheme] = useState('')` inside the component
    - _Requirements: 1.1, 1.2, 1.7_

  - [ ] 5.2 Render the `momentTheme` input in the panel header
    - Place the input below the search bar (or above if no hooks yet) inside the header `<div>`
    - Input: `type="text"`, `value={momentTheme}`, `onChange`, `placeholder="lucu, inspiratif, gaming…"`, `disabled={analyzing}`, `aria-label="Tema atau mood untuk analisis"`
    - Apply the same Tailwind/cn classes as specified in the design (border-border, bg-surface, focus:ring-accent, disabled:opacity-50, etc.)
    - Render the `×` clear button (SVG) absolutely positioned at right when `momentTheme !== ''`; clicking it calls `setMomentTheme('')`
    - The input must always be visible in the header regardless of hook list state (empty, analyzing, has results)
    - _Requirements: 1.1, 1.3, 1.5, 1.6, 1.8_

  - [ ]* 5.3 Write property tests for `HookListPanel` momentTheme state
    - **Property 1: Input state reflects typed value**
    - **Validates: Requirements 1.4**
    - **Property 2: Clear button visibility invariant**
    - **Validates: Requirements 1.5**
    - **Property 3: Clear button resets state**
    - **Validates: Requirements 1.6**
    - **Property 4: momentTheme round-trip through callback**
    - **Validates: Requirements 1.7**
    - Use `@testing-library/react` + `fast-check` for rendering and interaction

- [ ] 6. Update `ProjectViewClient.tsx` — wire `momentTheme` through to IPC
  - [ ] 6.1 Update `handleRunAnalysis` to accept and forward `momentTheme`
    - Change signature to `handleRunAnalysis(momentTheme: string)`
    - Trim the value; if non-empty call `ipc.analyze.start(projectId, trimmed)`, otherwise call `ipc.analyze.start(projectId)`
    - Pass `onRunAnalysis={(theme) => void handleRunAnalysis(theme)}` to `<HookListPanel>`
    - TopBar "Run Analysis" button calls `handleRunAnalysis('')` — no theme, backward-compatible
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ]* 6.2 Write unit test for `ProjectViewClient` momentTheme wiring
    - Verify `handleRunAnalysis('gaming')` calls `ipc.analyze.start(projectId, 'gaming')`
    - Verify `handleRunAnalysis('')` calls `ipc.analyze.start(projectId)` with only one argument
    - _Requirements: 2.2, 2.3_

- [ ] 7. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- `momentTheme` is never persisted to the database — it is a per-request runtime parameter only
- The TopBar "Run Analysis" button remains and always calls `handleRunAnalysis('')`, preserving backward compatibility
- Property tests use `fast-check` (already common in TypeScript/Node ecosystems); tag format: `Feature: hook-moment-theme, Property {N}: {title}`
- `sanitizeMomentTheme` must be exported from `Analyzer.ts` so it can be tested independently

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "3.2"] },
    { "id": 2, "tasks": ["5.1", "5.2"] },
    { "id": 3, "tasks": ["5.3", "6.1"] },
    { "id": 4, "tasks": ["6.2"] }
  ]
}
```
