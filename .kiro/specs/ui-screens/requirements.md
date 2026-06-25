# Requirements Document

## Introduction

The UI Screens feature implements the complete renderer-side user interface for the AI Shorts Generator desktop application. The Electron + Next.js backend pipeline, database layer, and IPC handlers are already fully implemented. This feature replaces all "coming soon" placeholder pages with functional screens that expose the pipeline's capabilities to the user.

The UI consists of five primary screens — Dashboard, Import, Project View, Export Queue, and Settings — plus two shared layout components (Sidebar and TopBar). All screens communicate with the Electron main process exclusively through the typed IPC bridge (`window.electron.invoke` / `window.electron.on`). No direct file system or database access occurs in the renderer.

---

## Glossary

- **Application**: The AI Shorts Generator Electron desktop application
- **Dashboard**: The root screen (`/`) displaying all projects as a card grid
- **Import Screen**: The screen (`/import`) for submitting a YouTube URL and monitoring download progress
- **Project View**: The screen (`/project/[id]`) for reviewing transcripts, hooks, and generating clips
- **Export Queue**: The screen (`/project/[id]/clips`) for monitoring and managing clip rendering
- **Settings Screen**: The screen (`/settings`) for configuring application preferences and checking dependencies
- **Sidebar**: The persistent left-navigation component linking to Dashboard, Import, and Settings
- **TopBar**: The persistent top bar displaying the current page title
- **Hook Card**: A UI card representing a single detected Hook with its viral score, summary, and time range
- **Clip Item**: A row in the Export Queue representing a single Clip with its status and progress
- **IPC Bridge**: The `window.electron` object exposed by the Electron preload script
- **Project**: A record representing one source YouTube video and all its derived clips
- **Hook**: A high-engagement moment identified by the Analyzer, with a viral score (0–100)
- **Clip**: A short-form vertical video segment derived from a Hook
- **Transcript**: A word-level, time-stamped text representation of a video's audio
- **Dependency**: An external tool required by the pipeline (yt-dlp, FFmpeg, Whisper.cpp, Ollama, MediaPipe)
- **Status Badge**: A small visual label indicating a project or clip's current pipeline state
- **Empty State**: The UI shown when a screen has no data to display

---

## Requirements

### Requirement 1: Shared Layout — Sidebar and TopBar

**User Story:** As a user, I want persistent navigation and a clear page title visible on every screen, so that I can move between sections of the application without losing context.

#### Acceptance Criteria

1. THE Sidebar SHALL render a vertical navigation panel on the left side of every screen, containing links to Dashboard (`/`), Import (`/import`), and Settings (`/settings`).
2. THE Sidebar SHALL visually highlight the link corresponding to the currently active route using the accent color (`#6366F1`).
3. WHEN the user clicks a Sidebar navigation link, THE Application SHALL navigate to the corresponding screen without a full page reload.
4. THE TopBar SHALL render a horizontal bar at the top of every screen displaying the current page title as primary text.
5. THE Sidebar SHALL display the application name "AI Shorts Generator" as a logo or wordmark at the top of the navigation panel.
6. THE Sidebar and TopBar SHALL remain visible and accessible on all five primary screens without overlapping page content.
7. THE Sidebar navigation links SHALL include accessible `aria-label` attributes and SHALL be keyboard-navigable using Tab and Enter keys.
8. IF the application is running in Electron, THE TopBar SHALL render within the custom title bar area so that the native OS title bar is not shown.

---

### Requirement 2: Dashboard Screen

**User Story:** As a user, I want to see all my past projects at a glance and quickly start a new import, so that I can manage my work and resume previous sessions efficiently.

#### Acceptance Criteria

1. WHEN the Dashboard screen loads, THE Dashboard SHALL invoke `project:list` via the IPC Bridge and display the returned `ProjectDashboardItem[]` as a responsive card grid.
2. WHILE the `project:list` call is in progress, THE Dashboard SHALL display a loading skeleton in place of the project grid.
3. IF `project:list` returns an empty array, THEN THE Dashboard SHALL display an empty state consisting of a large URL input field centered on screen with the label "Paste a YouTube URL to get started".
4. WHEN the user submits a URL in the Dashboard empty-state input, THE Dashboard SHALL navigate to the Import screen with the submitted URL pre-populated in the Import screen's URL field.
5. THE Dashboard SHALL render each project card containing: a thumbnail image (or a placeholder icon if `thumbnail` is `null`), the project title, the clip count, the creation date formatted as a human-readable relative time (e.g., "3 days ago"), and a status badge.
6. THE Dashboard SHALL display a status badge on each project card reflecting the project's most recent pipeline stage: one of `downloading`, `transcribing`, `analyzing`, `processing`, `complete`, or `failed`.
7. WHEN the user clicks a project card, THE Dashboard SHALL navigate to the Project View screen for that project (`/project/[id]`).
8. THE Dashboard SHALL provide a delete action on each project card (e.g., a context menu or icon button) that, when activated, displays a confirmation dialog before invoking `project:delete` via the IPC Bridge.
9. WHEN `project:delete` completes successfully, THE Dashboard SHALL remove the deleted project card from the grid without a full page reload.
10. IF `project:list` returns an error, THEN THE Dashboard SHALL display an inline error message with a "Retry" button that re-invokes `project:list`.
11. THE Dashboard SHALL include a prominent "New Import" button in the TopBar or Sidebar that navigates to the Import screen.
12. THE project card grid SHALL be keyboard-navigable, with each card focusable via Tab and activatable via Enter.

---

### Requirement 3: Import Screen

**User Story:** As a user, I want to paste a YouTube URL, select a quality, and watch the download progress in real time, so that I can import videos without switching to a terminal or external tool.

#### Acceptance Criteria

1. THE Import Screen SHALL display a full-width URL input field with placeholder text "Paste YouTube URL here…" and a submit button labeled "Import".
2. WHEN the user types or pastes text into the URL input, THE Import Screen SHALL validate the input against the recognized YouTube URL formats (standard `watch?v=`, shortened `youtu.be/`, embed `/embed/`) and display inline validation feedback below the input field.
3. IF the URL input contains a valid YouTube URL, THEN THE Import Screen SHALL display a green checkmark indicator and enable the submit button.
4. IF the URL input contains text that is not a valid YouTube URL, THEN THE Import Screen SHALL display a descriptive error message (e.g., "Not a YouTube URL" or "Unrecognized YouTube URL format") and disable the submit button.
5. THE Import Screen SHALL display a quality selector below the URL input as a segmented control with options: `1080p`, `720p`, `480p`, `360p`, defaulting to `1080p`.
6. WHEN the user submits a valid URL, THE Import Screen SHALL invoke `download:start` via the IPC Bridge with the URL and selected quality, then display a download progress card below the form.
7. THE download progress card SHALL display: a progress bar showing percentage complete, the current download speed (e.g., "3.2 MiB/s"), and the estimated time remaining (e.g., "01:23").
8. WHILE a download is in progress, THE Import Screen SHALL subscribe to `download:progress` events via the IPC Bridge and update the progress card in real time without polling.
9. WHILE a download is in progress, THE Import Screen SHALL display a "Cancel" button that, when clicked, invokes `download:cancel` and resets the Import Screen to its initial state.
10. WHEN a download completes successfully, THE Import Screen SHALL automatically navigate to the Project View screen for the newly created project.
11. IF `download:start` returns an error, THEN THE Import Screen SHALL display the error message inline below the progress card and re-enable the URL input and submit button.
12. THE URL input field SHALL support paste via keyboard shortcut (Ctrl+V / Cmd+V) and SHALL auto-focus when the Import Screen loads.
13. THE Import Screen SHALL prevent submitting a new download while a download is already in progress for the same session.

---

### Requirement 4: Project View Screen — Transcript Panel

**User Story:** As a user, I want to read and edit the video transcript, so that I can correct transcription errors before they appear in subtitle overlays.

#### Acceptance Criteria

1. WHEN the Project View screen loads, THE Project View SHALL invoke `project:get` via the IPC Bridge and render the transcript in a scrollable left panel.
2. THE Transcript Panel SHALL display each word as an individually selectable inline element, with words rendered in sequence preserving natural reading flow.
3. THE Transcript Panel SHALL visually distinguish words with `confidence < 0.6` by rendering them in a muted color (text secondary `#888888`) with an italic style.
4. WHEN the user double-clicks a word in the Transcript Panel, THE Transcript Panel SHALL render that word as an inline editable text input pre-populated with the word's current text.
5. WHEN the user confirms a word edit (by pressing Enter or clicking outside the input), THE Transcript Panel SHALL invoke `hook:update` via the IPC Bridge with the updated word text and restore the word to its non-editing display state.
6. IF a word edit is cancelled (by pressing Escape), THEN THE Transcript Panel SHALL restore the original word text without invoking any IPC call.
7. WHILE transcription is in progress for the project, THE Transcript Panel SHALL display a progress indicator showing the transcription percentage received from `transcribe:progress` events.
8. IF the project has no transcript yet, THEN THE Transcript Panel SHALL display a "Transcription pending" placeholder with a button to manually trigger transcription via `transcribe:start`.

---

### Requirement 5: Project View Screen — Hook List Panel

**User Story:** As a user, I want to review detected hooks ranked by viral score, adjust their time boundaries, and select which ones to turn into clips, so that I have full control over what gets exported.

#### Acceptance Criteria

1. THE Hook List Panel SHALL display all non-dismissed hooks for the project as vertically stacked cards, sorted by `viralScore` descending.
2. EACH Hook Card SHALL display: the hook's one-sentence summary, a viral score badge (0–100) styled with the accent color, the start time and end time formatted as `MM:SS`, and the hook duration in seconds.
3. THE Hook List Panel SHALL display a "Generate Clip" button on each Hook Card that, when clicked, invokes `clip:generate` via the IPC Bridge for that hook's ID and navigates to the Export Queue screen.
4. THE Hook List Panel SHALL display a "Dismiss" button on each Hook Card that, when clicked, invokes `hook:dismiss` via the IPC Bridge and removes the card from the list without a full page reload.
5. EACH Hook Card SHALL include a timeline scrubber that allows the user to adjust the hook's `startMs` and `endMs` values by dragging handles on a visual timeline representing the full video duration.
6. WHEN the user releases a timeline scrubber handle, THE Hook List Panel SHALL invoke `hook:update` via the IPC Bridge with the updated `startMs` or `endMs` value.
7. IF `hooks:list` returns an empty array after analysis completes, THEN THE Hook List Panel SHALL display an empty state message: "No hooks detected. Try re-running analysis."
8. WHILE hook analysis is in progress, THE Hook List Panel SHALL display a loading state with a spinner and the message "Analyzing transcript for hooks…".
9. IF `analyze:start` returns an error indicating Ollama is unavailable, THEN THE Hook List Panel SHALL display an error message: "Ollama is not running. Start Ollama and ensure the configured model is available." with a "Retry" button.
10. THE Hook List Panel SHALL display a "Generate All Clips" button above the hook list that invokes `clip:generate` for all non-dismissed hooks in a single action.

---

### Requirement 6: Project View Screen — Clip Preview Panel

**User Story:** As a user, I want to preview a generated clip and choose subtitle style and position before exporting, so that I can verify the output looks correct without leaving the project view.

#### Acceptance Criteria

1. THE Clip Preview Panel SHALL display an HTML5 `<video>` player in the right column of the Project View screen, sized to a 9:16 aspect ratio preview.
2. WHEN the user clicks "Generate Clip" on a Hook Card, THE Clip Preview Panel SHALL display a loading state while the clip is being processed, subscribing to `clip:progress` events to show a progress bar.
3. WHEN a clip's `status` becomes `complete`, THE Clip Preview Panel SHALL load the clip's `outputPath` into the video player and enable playback controls (play, pause, seek).
4. THE Clip Preview Panel SHALL display a subtitle style selector with three options: "Bold White", "Gradient Pop", and "Minimal Clean", defaulting to the value from `AppSettings.defaultSubtitleStyle`.
5. THE Clip Preview Panel SHALL display a subtitle position selector with three options: "Lower Third", "Upper Third", and "Center", defaulting to the value from `AppSettings.defaultSubtitlePosition`.
6. WHEN the user changes the subtitle style or position selector, THE Clip Preview Panel SHALL invoke `clip:generate` with the updated options to regenerate the clip with the new settings.
7. THE Clip Preview Panel SHALL display a zoom toggle (checkbox or switch) labeled "Auto Zoom", defaulting to enabled, that controls the `zoomEnabled` option passed to `clip:generate`.
8. IF no clip has been generated yet for the currently selected hook, THEN THE Clip Preview Panel SHALL display a placeholder with the message "Select a hook and click Generate Clip to preview".
9. IF a clip's `status` is `failed`, THEN THE Clip Preview Panel SHALL display the `errorMessage` from the Clip record and a "Retry" button that re-invokes `clip:generate`.

---

### Requirement 7: Export Queue Screen

**User Story:** As a user, I want to see all my clips in one place with their rendering status and take actions like preview, upload, or remove, so that I can manage my export batch efficiently.

#### Acceptance Criteria

1. WHEN the Export Queue screen loads, THE Export Queue SHALL invoke `clip:list` via the IPC Bridge and display the returned `Clip[]` as a full-width vertical list.
2. WHILE the `clip:list` call is in progress, THE Export Queue SHALL display a loading skeleton in place of the clip list.
3. EACH Clip Item in the Export Queue SHALL display: a thumbnail (extracted from the clip's output file or a placeholder), the hook summary text, a status badge (`pending`, `processing`, `complete`, or `failed`), and action buttons.
4. WHEN a Clip Item's `status` is `processing`, THE Export Queue SHALL display a progress bar and estimated time remaining for that item, updated in real time via `clip:progress` events from the IPC Bridge.
5. THE Export Queue SHALL subscribe to `clip:progress` events on mount and unsubscribe on unmount to prevent memory leaks.
6. EACH Clip Item SHALL display a "Preview" action button that, when clicked, opens the clip's `outputPath` in the in-app video player or via `shell:open-path`.
7. EACH Clip Item SHALL display an "Upload to YouTube" action button that, when clicked, navigates to the upload form for that clip or opens an upload dialog.
8. EACH Clip Item SHALL display a "Remove" action button that, when clicked, displays a confirmation dialog and then invokes `clip:delete` via the IPC Bridge, removing the item from the list.
9. IF a Clip Item's `status` is `failed`, THEN THE Export Queue SHALL display the `errorMessage` and a "Retry" button that re-invokes `clip:generate` for that clip's hook.
10. IF `clip:list` returns an empty array, THEN THE Export Queue SHALL display an empty state message: "No clips yet. Go to a project and generate clips from detected hooks." with a link back to the Dashboard.
11. THE Export Queue SHALL display a "Start Export" button that invokes `export:start` for all pending clips, and SHALL subscribe to `export:progress` events to update per-clip progress bars in real time.
12. WHEN all clips in the queue have `status` of `complete` or `failed`, THE Export Queue SHALL display a summary banner listing the count of successful and failed exports.
13. THE Export Queue SHALL display the total count of clips grouped by status (e.g., "3 complete · 1 processing · 2 pending") in the TopBar or as a summary row above the list.

---

### Requirement 8: Settings Screen

**User Story:** As a user, I want to configure storage paths, AI model preferences, and subtitle defaults, and see whether all required tools are installed, so that I can tailor the application to my machine and diagnose setup issues.

#### Acceptance Criteria

1. WHEN the Settings screen loads, THE Settings Screen SHALL invoke `settings:get` via the IPC Bridge and populate all form fields with the returned `AppSettings` values.
2. THE Settings Screen SHALL display settings in a two-column layout: the left column contains grouped settings forms, and the right column contains the dependency status panel.
3. THE Settings Screen SHALL display the following grouped settings sections in the left column:
   - **Directories**: Download directory (text input + "Browse" button), Export directory (text input + "Browse" button)
   - **AI Models**: Whisper model size (dropdown: tiny, base, small, medium, large), Ollama model name (text input)
   - **Subtitle Defaults**: Default subtitle style (segmented control: Bold White, Gradient Pop, Minimal Clean), Default subtitle position (segmented control: Lower Third, Upper Third, Center)
   - **Video**: Default video quality (segmented control: 1080p, 720p, 480p, 360p)
4. WHEN the user clicks "Browse" next to a directory input, THE Settings Screen SHALL invoke `dialog:open-directory` via the IPC Bridge and populate the corresponding input with the selected path.
5. WHEN the user changes any settings field and clicks "Save", THE Settings Screen SHALL invoke `settings:set` via the IPC Bridge with the changed values and display a success toast notification.
6. IF `settings:set` returns an error, THEN THE Settings Screen SHALL display an inline error message near the Save button without clearing the form.
7. THE Dependency Status Panel in the right column SHALL display a status row for each required tool: yt-dlp, FFmpeg, Whisper.cpp, Ollama, and MediaPipe.
8. EACH dependency status row SHALL display: the tool name, a green indicator icon if `detected` is `true`, a red indicator icon if `detected` is `false`, and the version string if available.
9. WHEN the Settings screen loads, THE Settings Screen SHALL invoke `deps:check` via the IPC Bridge and populate the Dependency Status Panel with the returned `DepsCheckResult`.
10. THE Dependency Status Panel SHALL display a "Re-check" button that, when clicked, re-invokes `deps:check` and refreshes all status rows.
11. IF any dependency has `detected: false`, THEN THE Settings Screen SHALL display a warning banner at the top of the Dependency Status Panel listing the missing tools and linking to installation instructions.
12. THE Settings Screen SHALL display a "YouTube Account" section showing the current OAuth authentication status (authenticated email or "Not connected") and a "Connect" or "Disconnect" button that invokes `upload:auth:start` or the appropriate revoke flow.

---

### Requirement 9: Real-Time IPC Event Handling

**User Story:** As a user, I want all progress indicators and status updates to reflect the actual pipeline state in real time, so that I never have to manually refresh a screen to see current progress.

#### Acceptance Criteria

1. THE Application SHALL subscribe to `download:progress` events on the Import Screen mount and unsubscribe on unmount, updating the download progress card without polling.
2. THE Application SHALL subscribe to `transcribe:progress` events on the Project View mount and unsubscribe on unmount, updating the Transcript Panel progress indicator.
3. THE Application SHALL subscribe to `clip:progress` events on the Project View and Export Queue mounts and unsubscribe on unmount, updating per-clip progress bars.
4. THE Application SHALL subscribe to `export:progress` events on the Export Queue mount and unsubscribe on unmount, updating per-clip export progress bars.
5. THE Application SHALL subscribe to `upload:progress` events on any screen displaying an active upload and unsubscribe when the upload completes or the screen unmounts.
6. WHEN an IPC event listener is registered via `window.electron.on`, THE Application SHALL store the returned unsubscribe function and call it during the React component's cleanup phase (i.e., in a `useEffect` return function).
7. IF the renderer receives a progress event for a `projectId` or `clipId` that does not match the currently displayed project or clip, THE Application SHALL silently discard the event without updating the UI.

---

### Requirement 10: Navigation Flow and Routing

**User Story:** As a user, I want the application to guide me through the natural workflow from import to export, so that I always know what to do next without reading documentation.

#### Acceptance Criteria

1. THE Application SHALL use Next.js App Router for client-side navigation between all screens without full page reloads.
2. WHEN a download completes on the Import Screen, THE Application SHALL automatically navigate to the Project View screen for the newly created project.
3. WHEN the user clicks "Generate Clip" on a Hook Card in the Project View, THE Application SHALL navigate to the Export Queue screen for that project after the clip is queued.
4. THE Application SHALL preserve the project ID in the URL path for the Project View (`/project/[id]`) and Export Queue (`/project/[id]/clips`) screens so that deep links and browser-back navigation work correctly.
5. IF the user navigates directly to `/project/[id]` with an ID that does not exist in the database, THEN THE Application SHALL display a "Project not found" error screen with a link back to the Dashboard.
6. THE Sidebar SHALL always be visible during navigation transitions so that the user can interrupt a workflow and switch screens at any time.
7. THE Application SHALL display a loading indicator in the TopBar or Sidebar during IPC calls that trigger navigation (e.g., after download completes) so the user knows a transition is pending.

---

### Requirement 11: Error States and User Feedback

**User Story:** As a user, I want clear, actionable error messages when something goes wrong, so that I can understand the problem and take corrective action without guessing.

#### Acceptance Criteria

1. IF any IPC `invoke` call returns a rejected promise, THEN THE Application SHALL display an error message in the relevant screen section identifying the failed operation and providing a retry action where applicable.
2. THE Application SHALL display IPC errors inline within the affected component (e.g., below a form field or within a card) rather than as modal dialogs, except for destructive confirmation dialogs.
3. IF the `OLLAMA_UNAVAILABLE` error code is received, THEN THE Application SHALL display the message: "Ollama is not running. Start Ollama and ensure the configured model is available." with a "Check Dependencies" link to the Settings screen.
4. IF the `DEPENDENCY_MISSING` error code is received, THEN THE Application SHALL display the message: "A required tool is missing. Check the Settings screen for dependency status." with a link to the Settings screen.
5. IF the `INVALID_URL` error code is received on the Import Screen, THEN THE Application SHALL display the validation error inline below the URL input field.
6. THE Application SHALL display a non-blocking toast notification for non-critical success events (e.g., settings saved, clip deleted) that auto-dismisses after 3 seconds.
7. THE Application SHALL display a non-blocking toast notification for non-critical failure events (e.g., a single clip export failed) that remains visible until dismissed by the user.
8. WHEN a destructive action is triggered (project delete, clip remove), THE Application SHALL display a confirmation dialog that requires explicit user confirmation before invoking the corresponding IPC call.

---

### Requirement 12: Accessibility

**User Story:** As a user, I want to navigate and operate the application using only a keyboard, so that the application is usable without a mouse and meets basic accessibility standards.

#### Acceptance Criteria

1. THE Application SHALL ensure all interactive elements (buttons, inputs, links, cards) are reachable via Tab key navigation in a logical document order.
2. THE Application SHALL ensure all interactive elements display a visible focus ring when focused via keyboard, using the accent color (`#6366F1`) as the focus indicator color.
3. THE Application SHALL provide `aria-label` or `aria-labelledby` attributes on all icon-only buttons (e.g., dismiss, delete, preview) to convey their purpose to screen readers.
4. THE Application SHALL use semantic HTML elements (`<nav>`, `<main>`, `<section>`, `<button>`, `<input>`) rather than generic `<div>` elements for interactive and landmark regions.
5. THE Application SHALL ensure all status badges and progress indicators include an `aria-live` region or `role="status"` attribute so that screen readers announce updates.
6. THE Application SHALL maintain a color contrast ratio of at least 4.5:1 between text and background for all primary text content, in compliance with WCAG 2.1 AA.
7. THE Application SHALL ensure all form inputs have associated `<label>` elements or `aria-label` attributes that describe the input's purpose.
8. THE Application SHALL ensure that modal dialogs (confirmation dialogs) trap keyboard focus within the dialog while open and return focus to the triggering element when closed.

---

### Requirement 13: Design System Compliance

**User Story:** As a developer, I want all UI components to follow the established design system, so that the application has a consistent visual identity across all screens.

#### Acceptance Criteria

1. THE Application SHALL use the following color tokens for all UI elements: background `#0A0A0A`, card surface `#111111`, border `#1E1E1E`, text primary `#F5F5F5`, text secondary `#888888`, accent `#6366F1`, destructive `#EF4444`, success `#22C55E`.
2. THE Application SHALL apply border radius values of 8px to cards, 6px to input fields, and 4px to badges and status indicators.
3. THE Application SHALL use Tailwind CSS utility classes and shadcn/ui component primitives for all UI construction, without introducing additional CSS frameworks or component libraries.
4. THE Application SHALL apply micro-interaction transitions of 150ms `ease-out` for hover and focus state changes on interactive elements.
5. THE Application SHALL apply page transition animations of 300ms `ease-in-out` when navigating between screens.
6. THE Application SHALL use the Inter typeface for all UI text and JetBrains Mono for timestamps, file paths, and code-like values.
7. THE Application SHALL render all screens in dark mode exclusively, using the `dark` class on the `<html>` element as already established in `renderer/app/layout.tsx`.
8. THE Application SHALL use the accent color (`#6366F1`) exclusively for primary call-to-action buttons, active navigation states, progress bars, and focus rings — not for decorative purposes.
