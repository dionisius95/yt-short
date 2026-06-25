# Implementation Plan: AI Shorts Generator

## Overview

This plan converts the AI Shorts Generator design into incremental coding tasks.

---

## Tasks

- [x] 1. Scaffold project structure and configure build tooling
  - _Requirements: 10.1_

- [x] 2. Define shared types and IPC channel constants
  - [x] 2.1 Create shared/types.ts with all TypeScript interfaces
    - _Requirements: 1.3, 2.2, 3.2, 4.4, 5.1, 7.7, 8.3, 10.1_
  - [x] 2.2 Create electron/ipc/channels.ts with all IPC channel name constants
    - _Requirements: 1.3, 2.3, 7.7, 8.5_

- [x] 3. Implement SQLite database layer
  - [x] 3.1 Create electron/db/schema.sql with DDL for all five tables
    - _Requirements: 9.1_
  - [x] 3.2 Create electron/db/database.ts with better-sqlite3 connection initialization
    - _Requirements: 9.1_
  - [x] 3.3 Create electron/db/repositories/ProjectRepo.ts with CRUD methods
    - _Requirements: 9.1, 9.2, 9.4_
  - [x]* 3.4 Write property test for project record round-trip persistence
    - **Property 3: Project Record Round-Trip Persistence**
    - **Validates: Requirements 1.6, 9.1, 7.4**
  - [x]* 3.5 Write property test for dashboard query fields completeness
    - **Property 22: Dashboard Query Returns All Required Fields for Every Project**
    - **Validates: Requirements 9.2**
  - [x]* 3.6 Write property test for project cascade deletion
    - **Property 23: Project Deletion Removes All Associated Records**
    - **Validates: Requirements 9.4**
  - [x] 3.7 Create electron/db/repositories/TranscriptRepo.ts with CRUD methods
    - _Requirements: 2.2, 11.1, 11.2_
  - [x] 3.8 Create electron/db/repositories/HookRepo.ts with CRUD methods
    - _Requirements: 3.4, 3.5, 3.6_
  - [x] 3.9 Create electron/db/repositories/ClipRepo.ts with CRUD methods
    - _Requirements: 4.1, 7.4, 8.8_

- [x] 4. Implement ConfigManager and application settings
  - [x] 4.1 Create electron/config/ConfigManager.ts wrapping electron-store
    - _Requirements: 10.1, 10.2_
  - [x]* 4.2 Write property test for settings round-trip persistence
    - **Property 25: Settings Round-Trip Persistence**
    - **Validates: Requirements 10.2**

- [x] 5. Implement URL validation and Downloader module
  - [x] 5.1 Create electron/utils/urlValidator.ts with validateYouTubeUrl function
    - _Requirements: 1.1, 1.4_
  - [x]* 5.2 Write property test for URL validation
    - **Property 1: URL Validation Accepts Valid Formats and Rejects Invalid Inputs**
    - **Validates: Requirements 1.1, 1.4**
  - [x] 5.3 Create electron/pipeline/Downloader.ts implementing the yt-dlp child process wrapper
    - _Requirements: 1.2, 1.3, 1.5, 1.7_
  - [x]* 5.4 Write property test for download progress parsing
    - **Property 2: Download Progress Parsing Extracts All Fields**
    - **Validates: Requirements 1.3**
  - [x]* 5.5 Write unit tests for Downloader
    - Test retry logic fires exactly 3 times on network failure
    - Test quality tier to yt-dlp format string mapping for all 4 tiers
    - Test cancel() kills the child process
    - _Requirements: 1.5, 1.7_

- [x] 6. Implement Transcriber module and transcript utilities
  - [x] 6.1 Create electron/pipeline/Transcriber.ts implementing the Whisper.cpp child process wrapper
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.7_
  - [x] 6.2 Create electron/utils/transcriptParser.ts with parseWhisperOutput function
    - Parse Whisper.cpp JSON output into TranscriptWord array
    - Flag words with probability < 0.6 as confidence < 0.6
    - _Requirements: 2.2, 11.1_
  - [x]* 6.3 Write property test for Whisper output parsing
    - **Property 4: Whisper.cpp Output Parsing Produces Complete TranscriptWord Records**
    - **Validates: Requirements 2.2, 11.1**
  - [x] 6.4 Create electron/utils/transcriptSerializer.ts with serializeTranscript and deserializeTranscript
    - Serialize to JSON string for SQLite storage; deserialize back to typed object
    - Surface a recovery option (not a crash) when deserialization fails
    - _Requirements: 11.2, 11.3, 11.5_
  - [x]* 6.5 Write property test for transcript serialization round-trip
    - **Property 5: Transcript Serialization Round-Trip**
    - **Validates: Requirements 11.2, 11.3**
  - [x]* 6.6 Write unit tests for Transcriber
    - Test progress events are emitted during transcription
    - Test empty audio detection sets is_empty flag
    - Test model size maps to correct ggml-size.bin path
    - _Requirements: 2.3, 2.5_

- [x] 7. Implement Analyzer module and hook utilities
  - [x] 7.1 Create electron/utils/hookParser.ts with parseHooks and clampHooks functions
    - Validate each hook: startMs < endMs, viralScore in [0, 100], summary non-empty; discard invalid hooks
    - Clamp result to 3-20 hooks, selecting highest-scoring when truncating
    - _Requirements: 3.2, 3.3_
  - [x]* 7.2 Write property test for hook viral score bounds
    - **Property 6: Hook Viral Scores Are Always in [0, 100]**
    - **Validates: Requirements 3.2**
  - [x]* 7.3 Write property test for hook count clamping
    - **Property 7: Hook Count Is Clamped to [3, 20]**
    - **Validates: Requirements 3.3**
  - [x] 7.4 Create electron/utils/hookSorter.ts with sortHooksByScore function
    - Sort hooks by viralScore descending
    - _Requirements: 3.4_
  - [x]* 7.5 Write property test for hook sort order
    - **Property 8: Hook List Is Sorted by Viral Score Descending**
    - **Validates: Requirements 3.4**
  - [x] 7.6 Create electron/utils/hookDismisser.ts with dismissHook function
    - Set dismissed = true on the target hook; leave all other hooks unchanged
    - _Requirements: 3.6_
  - [x]* 7.7 Write property test for hook dismiss isolation
    - **Property 9: Dismissing a Hook Does Not Affect Other Hooks**
    - **Validates: Requirements 3.6**
  - [x] 7.8 Create electron/pipeline/Analyzer.ts implementing the Ollama HTTP client
    - _Requirements: 3.1, 3.7, 3.8_
  - [x]* 7.9 Write unit tests for Analyzer
    - Test default model name is llama3
    - Test retry fires on JSON parse failure (max 2 retries)
    - Test OllamaUnavailableError is surfaced when Ollama is unreachable
    - _Requirements: 3.7, 3.8_
