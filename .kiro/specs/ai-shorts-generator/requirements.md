# Requirements Document

## Introduction

The AI Shorts Generator is a local-first desktop application built with Electron and Next.js that enables personal content creators to automatically transform long-form YouTube videos into viral short-form clips. The application runs entirely on the user's machine — leveraging yt-dlp for video acquisition, Whisper.cpp for local transcription, Ollama for LLM-based analysis, FFmpeg for video processing, and MediaPipe for face/speaker detection — with zero cloud dependency and zero monthly cost. The final output is a set of 9:16 vertical Shorts with animated subtitles, smart cropping, and optional direct upload to YouTube.

---

## Glossary

- **Application**: The AI Shorts Generator Electron desktop application
- **Downloader**: The yt-dlp integration responsible for fetching YouTube videos
- **Transcriber**: The Whisper.cpp integration responsible for local speech-to-text transcription
- **Analyzer**: The Ollama LLM integration responsible for hook detection and viral scoring
- **Processor**: The FFmpeg integration responsible for video editing, cropping, subtitle rendering, and export
- **Tracker**: The MediaPipe integration responsible for face detection and active speaker tracking
- **Clip**: A short-form vertical video segment (9:16 aspect ratio) derived from a source video
- **Hook**: A high-engagement moment or segment identified by the Analyzer as having viral potential
- **Viral Score**: A numeric score (0–100) assigned by the Analyzer to each Hook indicating predicted engagement potential
- **Transcript**: A time-stamped, word-level text representation of a video's audio produced by the Transcriber
- **Subtitle Block**: A timed text overlay rendered onto a Clip by the Processor
- **Export Queue**: The ordered list of Clips pending final render and export
- **Project**: A persistent record in SQLite representing one source YouTube video and all its derived Clips
- **YouTube Uploader**: The OAuth 2.0-authenticated component responsible for publishing Clips to YouTube

---

## Requirements

### Requirement 1: YouTube Video Import

**User Story:** As a content creator, I want to paste a YouTube URL and have the video downloaded automatically, so that I can process videos without manual file management.

#### Acceptance Criteria

1. THE Application SHALL provide a URL input field that accepts YouTube video URLs in standard, shortened (`youtu.be`), and embed formats.
2. WHEN a valid YouTube URL is submitted, THE Downloader SHALL begin downloading the video to a configurable local storage directory.
3. WHEN a download begins, THE Application SHALL display real-time download progress including percentage complete, download speed, and estimated time remaining.
4. IF an invalid or unsupported URL is submitted, THEN THE Application SHALL display a descriptive error message identifying the reason for rejection without crashing.
5. IF a network error occurs during download, THEN THE Downloader SHALL retry the download up to 3 times before surfacing a failure notification to the user.
6. WHEN a download completes successfully, THE Application SHALL create a new Project record in SQLite containing the video file path, source URL, title, duration, and creation timestamp.
7. THE Downloader SHALL download the highest available video quality up to 1080p by default, with the user able to select a lower quality tier before initiating the download.

---

### Requirement 2: Local Video Transcription

**User Story:** As a content creator, I want videos transcribed locally without sending data to any cloud service, so that my content remains private and I incur no API costs.

#### Acceptance Criteria

1. WHEN a video download completes, THE Transcriber SHALL automatically begin transcribing the video's audio track using Whisper.cpp running on the local machine.
2. THE Transcriber SHALL produce a word-level time-stamped Transcript stored in the Project's SQLite record.
3. WHILE transcription is in progress, THE Application SHALL display a progress indicator showing the percentage of audio processed.
4. THE Transcriber SHALL support English transcription by default, with the user able to select an alternative Whisper.cpp-supported language before transcription begins.
5. IF the audio track contains no detectable speech, THEN THE Transcriber SHALL mark the Transcript as empty and notify the user that no speech was detected.
6. WHEN transcription completes, THE Application SHALL make the full Transcript available for review and editing within the Project view.
7. THE Transcriber SHALL complete transcription of a 60-minute video in under 10 minutes on hardware meeting the minimum system requirements documented in the application.

---

### Requirement 3: Hook Detection and Viral Scoring

**User Story:** As a content creator, I want the application to automatically identify the most engaging moments in a video, so that I can quickly find clips worth turning into Shorts without watching the entire video.

#### Acceptance Criteria

1. WHEN a Transcript is available, THE Analyzer SHALL analyze the full Transcript using a locally running Ollama LLM model to identify candidate Hooks.
2. THE Analyzer SHALL assign each Hook a Viral Score between 0 and 100 based on criteria including emotional intensity, narrative tension, surprising statements, actionable insights, and quotability.
3. THE Analyzer SHALL identify a minimum of 3 and a maximum of 20 Hooks per video, bounded by the actual content available.
4. WHEN Hook detection completes, THE Application SHALL display all detected Hooks in a ranked list sorted by Viral Score descending, showing the Hook's start time, end time, duration, score, and a one-sentence summary.
5. THE Application SHALL allow the user to manually adjust the start and end time of any Hook using a timeline scrubber before generating a Clip.
6. THE Application SHALL allow the user to dismiss any Hook from the list without affecting other Hooks.
7. IF the Ollama service is not running or the selected model is not available, THEN THE Application SHALL display a clear error message with instructions to start Ollama and pull the required model.
8. THE Analyzer SHALL use a user-configurable Ollama model name, defaulting to `llama3`.

---

### Requirement 4: Clip Generation

**User Story:** As a content creator, I want the application to automatically generate multiple Shorts from detected Hooks, so that I can produce a batch of clips without manual video editing.

#### Acceptance Criteria

1. WHEN the user initiates clip generation, THE Application SHALL add all selected Hooks to the Export Queue as pending Clips.
2. THE Processor SHALL generate each Clip by trimming the source video to the Hook's start and end times using FFmpeg.
3. THE Processor SHALL crop each Clip to a 9:16 aspect ratio targeting a 1080×1920 output resolution.
4. WHEN generating a Clip, THE Tracker SHALL analyze each frame to detect faces and identify the active speaker, and THE Processor SHALL center the crop window on the detected subject.
5. IF no face is detected in a frame, THEN THE Processor SHALL apply a center-crop fallback for that frame.
6. THE Processor SHALL apply smooth pan and zoom transitions when the crop window shifts between subjects, with a maximum pan speed of 20% of frame width per second.
7. THE Application SHALL allow the user to preview any generated Clip before export using an in-app video player.
8. THE Application SHALL display the Export Queue with per-Clip status: pending, processing, complete, or failed.

---

### Requirement 5: Animated Subtitle Generation

**User Story:** As a content creator, I want animated subtitles automatically burned into my Shorts, so that my clips are accessible and optimized for silent viewing without additional editing.

#### Acceptance Criteria

1. WHEN a Clip is generated, THE Processor SHALL extract the corresponding Transcript segment and render Subtitle Blocks as burned-in text overlays on the Clip.
2. THE Processor SHALL render Subtitle Blocks using a word-highlight animation style where each word is visually emphasized as it is spoken.
3. THE Application SHALL provide at least 3 subtitle style presets (e.g., Bold White, Gradient Pop, Minimal Clean) that the user can select before export.
4. THE Processor SHALL position Subtitle Blocks in the lower third of the frame by default, with the user able to reposition them to the upper third or center.
5. THE Processor SHALL wrap Subtitle Blocks to a maximum of 3 words per line to maintain readability on mobile screens.
6. IF a Transcript segment contains a word with confidence below 0.6, THEN THE Processor SHALL render that word in a visually distinct style (e.g., italicized or dimmed) to indicate low confidence.
7. THE Application SHALL allow the user to edit individual Subtitle Block text before final export.

---

### Requirement 6: Auto Zoom Effects

**User Story:** As a content creator, I want automatic zoom effects applied to my Shorts, so that the clips feel dynamic and engaging without manual keyframing.

#### Acceptance Criteria

1. THE Processor SHALL apply a subtle Ken Burns-style zoom effect to Clips, with a zoom range between 100% and 115% of the base crop.
2. WHEN the Tracker detects a change in active speaker, THE Processor SHALL apply a quick zoom-in transition to the new speaker's face within 0.5 seconds.
3. THE Application SHALL allow the user to disable auto zoom effects per Clip before export.
4. THE Processor SHALL ensure zoom transitions do not introduce visible frame artifacts or black borders at any point during the Clip.

---

### Requirement 7: Export Queue and Rendering

**User Story:** As a content creator, I want to manage and render multiple Clips in a queue, so that I can batch-process my Shorts and continue working while exports complete.

#### Acceptance Criteria

1. THE Application SHALL allow the user to add, reorder, and remove Clips from the Export Queue before rendering begins.
2. WHEN the user starts the export queue, THE Processor SHALL render Clips sequentially, one at a time, to avoid resource contention.
3. THE Processor SHALL export each Clip as an MP4 file encoded with H.264 video and AAC audio at a minimum bitrate of 4 Mbps video and 128 kbps audio.
4. WHEN a Clip export completes, THE Application SHALL save the output file to a user-configurable export directory and update the Project record in SQLite with the output file path.
5. IF a Clip export fails, THEN THE Application SHALL log the error, mark the Clip as failed in the Export Queue, and continue processing remaining Clips.
6. WHEN all Clips in the Export Queue have been processed, THE Application SHALL display a summary notification listing completed and failed exports.
7. THE Application SHALL display real-time rendering progress per Clip including percentage complete and estimated time remaining.

---

### Requirement 8: YouTube Upload Integration

**User Story:** As a content creator, I want to upload finished Shorts directly to YouTube from within the application, so that I can publish my content without switching between tools.

#### Acceptance Criteria

1. THE YouTube Uploader SHALL authenticate with YouTube using OAuth 2.0, storing refresh tokens securely in the local system keychain.
2. WHEN the user initiates an upload, THE YouTube Uploader SHALL upload the exported Clip file to the authenticated YouTube account as a Short.
3. THE Application SHALL allow the user to set the title, description, tags, and privacy setting (public, unlisted, private) for each Clip before upload.
4. THE Application SHALL pre-populate the title field with the Hook's one-sentence summary and allow the user to edit it before upload.
5. WHEN an upload is in progress, THE Application SHALL display upload progress as a percentage and allow the user to cancel the upload.
6. IF an upload fails due to a network error, THEN THE YouTube Uploader SHALL retry the upload up to 3 times with exponential backoff before surfacing a failure notification.
7. IF the OAuth token has expired, THEN THE YouTube Uploader SHALL silently refresh the token before retrying the upload without requiring the user to re-authenticate.
8. WHEN an upload completes, THE Application SHALL display the published YouTube URL and provide a one-click button to open it in the default browser.

---

### Requirement 9: Project Management and Persistence

**User Story:** As a content creator, I want all my projects and clips saved locally, so that I can return to previous work, review past exports, and manage my storage without losing progress.

#### Acceptance Criteria

1. THE Application SHALL persist all Project data — including source URL, file paths, Transcripts, Hooks, Viral Scores, Clips, and export history — in a local SQLite database.
2. THE Application SHALL display a Projects dashboard listing all past Projects with their title, thumbnail, creation date, number of Clips generated, and total export count.
3. THE Application SHALL allow the user to open any past Project and resume editing, re-exporting, or uploading Clips.
4. THE Application SHALL allow the user to delete a Project, which SHALL remove the Project record and all associated Clips from SQLite and optionally delete the source video and export files from disk.
5. WHEN the user deletes a Project with files on disk, THE Application SHALL present a confirmation dialog listing the files to be deleted before proceeding.
6. THE Application SHALL display total disk usage for all stored videos and exports, and SHALL warn the user when available disk space falls below 5 GB.

---

### Requirement 10: Application Settings and Configuration

**User Story:** As a content creator, I want to configure the application's AI models, storage paths, and processing preferences, so that I can optimize performance for my specific hardware and workflow.

#### Acceptance Criteria

1. THE Application SHALL provide a Settings panel where the user can configure: default download directory, default export directory, Whisper.cpp model size (tiny, base, small, medium, large), Ollama model name, default subtitle style, default video quality, and YouTube OAuth credentials.
2. THE Application SHALL persist all settings in a local configuration file and restore them on application restart.
3. WHEN the user changes the Whisper.cpp model size, THE Application SHALL check whether the selected model file is present on disk and, IF the model file is absent, THEN THE Application SHALL provide a one-click download button for the model.
4. WHEN the user changes the Ollama model name, THE Application SHALL verify the model is available in the local Ollama instance and, IF the model is not available, THEN THE Application SHALL display the command required to pull the model.
5. THE Application SHALL display the current status of required external dependencies (yt-dlp, FFmpeg, Whisper.cpp, Ollama, MediaPipe) in the Settings panel, indicating whether each is detected and operational.

---

### Requirement 11: Transcript Parsing and Round-Trip Integrity

**User Story:** As a content creator, I want the transcript data to be reliably parsed and stored, so that subtitle timing is accurate and I can edit transcripts without data loss.

#### Acceptance Criteria

1. THE Transcriber SHALL parse Whisper.cpp output into a structured Transcript format containing, for each word: the word text, start time in milliseconds, end time in milliseconds, and confidence score.
2. THE Application SHALL serialize Transcript objects to JSON for storage in SQLite and deserialize them back to Transcript objects for processing.
3. FOR ALL valid Transcript objects, serializing then deserializing SHALL produce a Transcript object equivalent to the original (round-trip property).
4. THE Application SHALL provide a Transcript editor where the user can modify word text, and THE Processor SHALL use the edited Transcript when rendering Subtitle Blocks.
5. IF a Transcript JSON record in SQLite is malformed or fails to deserialize, THEN THE Application SHALL surface a recovery option to re-run transcription for that Project without deleting other Project data.
