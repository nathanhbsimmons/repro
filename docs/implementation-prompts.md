# Implementation Task Prompts

> Atomic prompts to feed to subagents via the Task tool. Each prompt is self-contained with full context. Copy-paste these into the orchestrator's Task invocations.

---

## Phase 1: Infrastructure & Scaffolding

### Task 1.1 — @architect: Plan the WXT project structure

```
You are planning a Manifest V3 Chrome Extension called "QA Companion" using the WXT framework.

Requirements:
- Record tab video + microphone audio simultaneously
- Capture network requests and console logs via chrome.debugger (CDP)
- Take high-fidelity screenshots via ImageCapture API
- Generate a DOCX report with synchronized timestamps
- Record DOM mutations via rrweb for replay

Design the following:
1. Complete WXT entrypoint file tree (every file path)
2. Message-passing schema: define every message type with sender, receiver, and payload TypeScript interface
3. Required permissions for wxt.config.ts
4. Component responsibility matrix (which component owns which capability)

Key constraints:
- Service Worker: NO DOM, NO MediaStream, NO long-lived state
- Offscreen Document: ALL media capture happens here
- Content Script: DOM event listening + rrweb + localStorage serialization
- Popup: Start/Stop controls, status display, screenshot button

Output a structured plan the @extension_expert can execute.
```

### Task 1.2 — @extension_expert: Scaffold the WXT project

```
Initialize a new WXT project for the QA Companion Chrome Extension.

Steps:
1. Run `npx wxt@latest init qa-companion --template vanilla` (or react if the architect specified React)
2. Install dependencies: `npm install idb-keyval docx rrweb date-fns`
3. Install dev dependencies: `npm install -D @anthropic-ai/claude-code` (if needed for types)
4. Create the directory structure from the architect's plan:
   - entrypoints/background.ts (Service Worker)
   - entrypoints/offscreen/index.html
   - entrypoints/offscreen/main.ts
   - entrypoints/popup/index.html + App.tsx (or App.ts)
   - entrypoints/content.ts
   - types/messages.ts (shared message type definitions)
   - lib/storage.ts (idb-keyval wrapper)
   - lib/sync.ts (timestamp synchronization utilities)
   - lib/report.ts (DOCX generation)
5. Configure wxt.config.ts with permissions: tabCapture, offscreen, debugger, storage, activeTab, scripting
6. Set up tsconfig.json with strict mode
7. Verify: `npm run build` succeeds with no errors

Do NOT implement any logic yet — just create the skeleton files with TypeScript interfaces and TODO comments.
```

---

## Phase 2: The Offscreen Media Engine

### Task 2.1 — @extension_expert: Implement audio mixing in Offscreen Document

```
Implement the audio mixing pipeline in entrypoints/offscreen/main.ts.

This is a WXT/TypeScript project. The Offscreen Document is the ONLY place where media capture can happen (MV3 constraint).

Requirements:
1. Listen for a START_RECORDING message from the Service Worker containing a streamId
2. Use chrome.tabCapture.getMediaStreamId or getDisplayMedia to get the tab stream
3. Get microphone audio via navigator.mediaDevices.getUserMedia({ audio: true })
4. Create an AudioContext with the following routing:
   - TabAudioSource → GainNode → MixDestination (for recording)
   - TabAudioSource → audioContext.destination (so user hears the tab — CRITICAL)
   - MicAudioSource → GainNode → MixDestination (for recording)
   - MicAudioSource must NOT go to audioContext.destination (feedback loop!)
5. Create a MediaRecorder on the mixed stream (video from tab + mixed audio)
6. On each dataavailable event, store chunks in IndexedDB via idb-keyval
7. Listen for STOP_RECORDING message — stop recorder, close AudioContext, stop all tracks
8. Send RECORDING_COMPLETE message back to Service Worker with the IndexedDB key

Use the message types from types/messages.ts.
Verify: npm run typecheck passes.
```

### Task 2.2 — @extension_expert: Implement screenshot capture

```
Add screenshot capture to the Offscreen Document using the ImageCapture API.

Requirements:
1. Listen for TAKE_SCREENSHOT message from Service Worker
2. Use the video track from the active tab stream (must already be recording)
3. Create new ImageCapture(videoTrack)
4. Call grabFrame() to get an ImageBitmap at native resolution
5. Convert ImageBitmap to Blob via OffscreenCanvas
6. Store the Blob in IndexedDB with a timestamp key
7. Send SCREENSHOT_TAKEN message back with the key and timestamp

Edge cases:
- If not currently recording, return an error message
- If grabFrame() fails (e.g., track ended), handle gracefully

Verify: npm run typecheck passes.
```

---

## Phase 3: The Telemetry Vacuum

### Task 3.1 — @extension_expert: Implement CDP network logging

```
Implement network request capture via chrome.debugger in entrypoints/background.ts.

Requirements:
1. When recording starts, attach debugger to the target tab: chrome.debugger.attach({ tabId }, "1.3")
2. Enable the Network domain: chrome.debugger.sendCommand({ tabId }, "Network.enable")
3. Listen for these CDP events via chrome.debugger.onEvent:
   - Network.requestWillBeSent → capture URL, method, headers, timestamp, wallTime
   - Network.responseReceived → capture status code, headers, mimeType
   - Network.loadingFailed → capture error text
4. For failed requests (status >= 400) or XHR/Fetch requests, call Network.getResponseBody to capture the response payload
5. Filter: INCLUDE XHR, Fetch, WebSocket, Document. EXCLUDE images, fonts, stylesheets, media (unless status >= 400)
6. Store log entries in a buffer array. Flush to IndexedDB every 50 entries or every 10 seconds (whichever comes first)
7. Each log entry must include: { url, method, status, mimeType, wallTime, videoOffset, responseBody?, error? }
8. videoOffset = (wallTime * 1000) - sessionStartTime

When recording stops, detach the debugger: chrome.debugger.detach({ tabId })

Handle chrome.runtime.lastError on EVERY chrome.debugger call.
Verify: npm run typecheck passes.
```

### Task 3.2 — @extension_expert: Implement CDP console logging

```
Implement console log capture via chrome.debugger in entrypoints/background.ts.

Requirements:
1. After debugger is attached (Task 3.1), enable Runtime domain: chrome.debugger.sendCommand({ tabId }, "Runtime.enable")
2. Listen for Runtime.consoleAPICalled events via chrome.debugger.onEvent
3. Capture: message text, severity level (log, warn, error), stack trace (if error), timestamp
4. Normalize the timestamp to video offset using the same formula as network logs
5. Store in the same IndexedDB flush pattern as network logs (buffer + periodic flush)
6. Each entry: { level, text, stackTrace?, videoOffset, wallTime }

Also capture Runtime.exceptionThrown for uncaught exceptions.

Verify: npm run typecheck passes.
```

---

## Phase 3.5: Synchronization & State

### Task 3.5.1 — @extension_expert: Implement timestamp synchronization

```
Implement the synchronization module in lib/sync.ts.

The problem: video time, wall clock time, and CDP timestamps use different reference points. We need to unify them.

Requirements:
1. Export a function createSessionClock() that returns:
   - sessionStartTime: number (Date.now() captured IMMEDIATELY before mediaRecorder.start())
   - toVideoOffset(wallTimeSeconds: number): number — converts CDP wallTime to ms offset in video
   - toVideoOffsetFromDate(dateNowMs: number): number — converts Date.now() to ms offset in video
   - formatVideoTimestamp(offsetMs: number): string — returns "MM:SS.mmm" format

2. The Service Worker must call createSessionClock() and store the sessionStartTime
3. Pass sessionStartTime to the Offscreen Document so it can tag screenshots
4. Pass sessionStartTime to the CDP event handlers so they can compute videoOffset

Formulas:
- videoOffset = (cdpWallTime * 1000) - sessionStartTime
- videoOffset = dateNowMs - sessionStartTime

Verify: npm run typecheck passes.
Write unit tests for the math functions in lib/sync.test.ts.
```

### Task 3.5.2 — @extension_expert: Implement content script for replication steps

```
Implement heuristic action logging in entrypoints/content.ts.

Requirements:
1. Listen for user interaction events: click, input, change, submit, keydown (Enter/Escape only)
2. For each event, generate a human-readable step:
   - Click: "Clicked [tagName] '[textContent or aria-label]'" (truncate text to 50 chars)
   - Input: "Typed in [tagName] '[name or placeholder]'"
   - Submit: "Submitted form '[form name or action URL]'"
   - Navigation: "Page navigated to [URL]"
3. Include a timestamp (Date.now()) with each step
4. Send steps to the Service Worker via chrome.runtime.sendMessage as they occur
5. The Service Worker buffers them and flushes to IndexedDB

Do NOT use rrweb in this task — that's a separate concern. This is the text-based replication step generator.

Verify: npm run typecheck passes.
```

---

## Phase 4: Report Generation

### Task 4.1 — @extension_expert: Implement DOCX report generator

```
Implement the DOCX report generator in lib/report.ts using the docx library.

Requirements:
1. Export async function generateReport(sessionId: string): Promise<Blob>
2. Fetch all data from IndexedDB for the given session:
   - Video blob (as a download link reference, not embedded)
   - Screenshots (embed as images in the doc)
   - Network logs
   - Console logs
   - Replication steps
3. Generate a Word document with these sections:

   **Title Page:**
   - "QA Session Report"
   - Date/time, URL tested, session duration

   **Replication Steps:**
   - Numbered list with video timestamps: "1. [00:12.345] Clicked 'Login' button"

   **Screenshots:**
   - Each screenshot with its video timestamp caption

   **Network Log Table:**
   | # | Video Time | Method | URL | Status | Type | Response (truncated) |

   **Console Log Table:**
   | # | Video Time | Level | Message | Stack Trace |

   **Session Metadata:**
   - Browser version, extension version, permissions used

4. Use date-fns for timestamp formatting
5. Trigger download via URL.createObjectURL + anchor click in the popup

Verify: npm run typecheck passes.
```

### Task 4.2 — @extension_expert: Wire up the Popup UI

```
Implement the Popup UI in entrypoints/popup/.

Requirements:
1. Simple controls:
   - "Start Recording" button (sends START_RECORDING to Service Worker)
   - "Stop Recording" button (sends STOP_RECORDING)
   - "Take Screenshot" button (sends TAKE_SCREENSHOT, only enabled during recording)
   - "Generate Report" button (only enabled after recording stops)
   - Status indicator (idle / recording / processing)
   - Timer showing recording duration
2. State management:
   - Query Service Worker for current recording state on popup open
   - Update UI reactively based on messages from Service Worker
3. Styling: Clean, minimal CSS. Dark theme preferred for dev tools aesthetic.
4. All buttons send typed messages from types/messages.ts

Verify: npm run typecheck and npm run build pass.
```

---

## Review Tasks

### Review 1 — @qa_engineer: Full MV3 compliance audit

```
Review the entire codebase for Manifest V3 compliance and security.

Focus areas:
1. Does the Service Worker (background.ts) use ANY DOM APIs? (Must be zero)
2. Is the Offscreen Document properly created before media capture and destroyed after?
3. Are ALL chrome.* API callbacks checking chrome.runtime.lastError?
4. Do permissions in wxt.config.ts match actual API usage (no over/under-requesting)?
5. Are message types properly defined and used consistently?
6. Is sensitive data (response bodies, cookies) sanitized before storage?
7. Are there any XSS vectors in the popup or report generation?
8. Is the synchronization math correct? (videoOffset = wallTime*1000 - sessionStartTime)

Output: APPROVE or REJECT with specific file:line findings.
```

### Review 2 — @perf_ghost: Performance and resource lifecycle audit

```
Review the media pipeline and telemetry code for performance issues.

Focus areas:
1. Is AudioContext.close() called when recording stops?
2. Are all MediaStream tracks stopped when recording ends?
3. Is the PerformanceObserver (if used) disconnected on stop?
4. Are log buffers bounded? (What happens on a 10-minute recording?)
5. Are MediaRecorder chunks streamed to IndexedDB or accumulated in memory?
6. Is chrome.debugger detached on stop AND on tab close?
7. What is the memory footprint of a 5-minute recording?

Output: Findings with severity ratings and recommended buffer limits.
```
