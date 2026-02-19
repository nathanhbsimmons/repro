// entrypoints/popup/main.ts
// Popup UI logic (vanilla TypeScript, no React)
// Handles user interactions and session status display

import './style.css';
import { MessageType } from '../../types/messages';
import type { RuntimeMessage } from '../../types/messages';
import {
  generateReport,
  downloadReport,
  generateReportFilename,
  buildReplicationSteps,
} from '../../lib/report';
import {
  getAllScreenshots,
  getNetworkEvents,
  getConsoleEvents,
  getDOMEvents,
  getSessionMetadata,
} from '../../lib/storage';
import { createSessionClock } from '../../lib/sync';
import type { Screenshot } from '../../types/telemetry';
import type { SessionMetadata } from '../../types/session';
import type { ReportData } from '../../types/report';

// -----------------------------------------------------------------------
// DOM element references
// -----------------------------------------------------------------------
let startBtn: HTMLButtonElement;
let stopBtn: HTMLButtonElement;
let screenshotBtn: HTMLButtonElement;
let reportBtn: HTMLButtonElement;
let statusText: HTMLSpanElement;
let durationText: HTMLSpanElement;
let eventCountText: HTMLSpanElement;
let screenshotCountText: HTMLSpanElement;
let networkCountText: HTMLSpanElement;
let errorMessage: HTMLDivElement;
let sessionInfo: HTMLDivElement;
let statusIndicator: HTMLDivElement;
let includeAudioCheckbox: HTMLInputElement;
let includeMicrophoneCheckbox: HTMLInputElement;

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------
let currentTabId: number | null = null;
let currentSessionId: string | null = null;
let isRecording = false;
let durationTimer: ReturnType<typeof setInterval> | null = null;
let recordingStartTime: number | null = null;
let errorTimeout: ReturnType<typeof setTimeout> | null = null;

// -----------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------

function initializeUI(): void {
  startBtn = document.getElementById('start-btn') as HTMLButtonElement;
  stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
  screenshotBtn = document.getElementById('screenshot-btn') as HTMLButtonElement;
  reportBtn = document.getElementById('report-btn') as HTMLButtonElement;
  statusText = document.getElementById('status-text') as HTMLSpanElement;
  durationText = document.getElementById('duration') as HTMLSpanElement;
  eventCountText = document.getElementById('event-count') as HTMLSpanElement;
  screenshotCountText = document.getElementById('screenshot-count') as HTMLSpanElement;
  networkCountText = document.getElementById('network-count') as HTMLSpanElement;
  errorMessage = document.getElementById('error-message') as HTMLDivElement;
  sessionInfo = document.getElementById('session-info') as HTMLDivElement;
  statusIndicator = document.querySelector('.status-indicator') as HTMLDivElement;
  includeAudioCheckbox = document.getElementById('include-audio') as HTMLInputElement;
  includeMicrophoneCheckbox = document.getElementById('include-microphone') as HTMLInputElement;

  // Attach event listeners
  startBtn.addEventListener('click', handleStartRecording);
  stopBtn.addEventListener('click', handleStopRecording);
  screenshotBtn.addEventListener('click', handleTakeScreenshot);
  reportBtn.addEventListener('click', handleGenerateReport);

  // Register message listener for background → popup updates
  chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
    if (message.type === MessageType.SESSION_STATUS_UPDATE) {
      const payload = message.payload;
      // Only handle updates for our current tab
      if (payload.tabId !== currentTabId) return;

      if (payload.sessionId) {
        currentSessionId = payload.sessionId;
      }

      updateEventCounts(
        payload.chunkCount ?? 0,
        payload.screenshotCount ?? 0,
        payload.networkEventCount ?? 0,
        payload.consoleEventCount ?? 0
      );

      if (payload.status === 'recording' && !isRecording) {
        isRecording = true;
        recordingStartTime = Date.now();
        startDurationTimer();
        updateUIState('recording');
        if (payload.micFailed) {
          showError('Recording without microphone — permission not granted');
        }
      } else if (payload.status === 'idle' && isRecording) {
        isRecording = false;
        stopDurationTimer();
        updateUIState('idle');
        // Enable report button if we have a completed session
        if (currentSessionId) {
          reportBtn.disabled = false;
        }
      } else if (payload.status === 'completed') {
        isRecording = false;
        stopDurationTimer();
        currentSessionId = payload.sessionId || null;
        updateUIState('completed');
      }
    }

    if (message.type === MessageType.RECORDING_ERROR) {
      const payload = message.payload;
      if (payload.tabId !== currentTabId) return;
      isRecording = false;
      stopDurationTimer();
      showError(payload.error);
      updateUIState('error');
    }
  });

  // Get current tab and query session status
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs: chrome.tabs.Tab[]) => {
    if (chrome.runtime.lastError) {
      console.warn('Popup: tabs.query error', chrome.runtime.lastError.message);
      return;
    }
    const tab = tabs[0];
    if (tab?.id !== undefined) {
      currentTabId = tab.id;
      querySessionStatus();
    }
  });

  console.log('Popup UI initialized');
}

// -----------------------------------------------------------------------
// Query session status on open (handles popup closed during recording)
// -----------------------------------------------------------------------

function querySessionStatus(): void {
  if (currentTabId === null) return;

  chrome.runtime.sendMessage(
    {
      type: MessageType.GET_SESSION_STATUS,
      timestamp: Date.now(),
      payload: { tabId: currentTabId },
    } satisfies RuntimeMessage,
    (response: { success: boolean; session?: { status: string; sessionId?: string; sessionStartTime?: number; recordingChunkCount?: number; screenshotCount?: number; networkEventCount?: number; consoleEventCount?: number } }) => {
      if (chrome.runtime.lastError) {
        console.warn('Popup: GET_SESSION_STATUS error', chrome.runtime.lastError.message);
        return;
      }
      if (!response?.success || !response.session) return;

      const session = response.session;

      if (session.sessionId) {
        currentSessionId = session.sessionId;
      }

      updateEventCounts(
        session.recordingChunkCount ?? 0,
        session.screenshotCount ?? 0,
        session.networkEventCount ?? 0,
        session.consoleEventCount ?? 0
      );

      if (session.status === 'recording') {
        isRecording = true;
        recordingStartTime = session.sessionStartTime ?? Date.now();
        startDurationTimer();
        updateUIState('recording');
      } else if (session.status === 'stopping') {
        updateUIState('stopping');
      } else if (session.status === 'error') {
        updateUIState('error');
      } else if (session.status === 'completed') {
        currentSessionId = session.sessionId || null;
        updateUIState('completed');
      }
      // else idle — default state already set
    }
  );
}

// -----------------------------------------------------------------------
// Message handlers
// -----------------------------------------------------------------------

function handleStartRecording(): void {
  if (!currentTabId) {
    showError('No active tab found');
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: MessageType.START_RECORDING,
      timestamp: Date.now(),
      payload: {
        tabId: currentTabId,
        includeAudio: includeAudioCheckbox.checked,
        includeMicrophone: includeMicrophoneCheckbox.checked,
      },
    } satisfies RuntimeMessage,
    (response: { success: boolean; sessionId?: string; error?: string }) => {
      if (chrome.runtime.lastError) {
        showError(chrome.runtime.lastError.message ?? 'Failed to start recording');
        return;
      }
      if (!response?.success) {
        showError(response?.error ?? 'Failed to start recording');
        return;
      }
      if (response.sessionId) {
        currentSessionId = response.sessionId;
      }
      reportBtn.disabled = true;
      updateUIState('starting');
    }
  );
}

function handleStopRecording(): void {
  if (!currentTabId) return;

  // Optimistically update UI
  stopDurationTimer();
  updateUIState('stopping');

  chrome.runtime.sendMessage(
    {
      type: MessageType.STOP_RECORDING,
      timestamp: Date.now(),
      payload: {
        tabId: currentTabId,
        generateReport: false,
      },
    } satisfies RuntimeMessage,
    (response: { success: boolean; error?: string }) => {
      if (chrome.runtime.lastError) {
        showError(chrome.runtime.lastError.message ?? 'Failed to stop recording');
        isRecording = false;
        updateUIState('error');
        return;
      }
      if (!response?.success) {
        showError(response?.error ?? 'Failed to stop recording');
        isRecording = false;
        updateUIState('error');
        return;
      }
      isRecording = false;
      updateUIState('idle');
      // Enable report button now that recording is stopped
      if (currentSessionId) {
        reportBtn.disabled = false;
      }
    }
  );
}

function handleTakeScreenshot(): void {
  if (!currentTabId || !isRecording) return;

  chrome.runtime.sendMessage(
    {
      type: MessageType.TAKE_SCREENSHOT,
      timestamp: Date.now(),
      payload: {
        tabId: currentTabId,
      },
    } satisfies RuntimeMessage,
    (response: { success: boolean; error?: string }) => {
      if (chrome.runtime.lastError) {
        console.warn('Popup: TAKE_SCREENSHOT error', chrome.runtime.lastError.message);
        return;
      }
      if (!response?.success) {
        console.warn('Popup: Screenshot failed', response?.error);
      }
    }
  );
}

async function handleGenerateReport(): Promise<void> {
  if (!currentSessionId) {
    showError('No session data available');
    return;
  }

  reportBtn.disabled = true;
  reportBtn.textContent = 'Generating...';

  try {
    // Gather all session data from IndexedDB
    const [rawScreenshots, rawNetworkEvents, rawConsoleEvents, rawDOMEvents, rawMetadata] =
      await Promise.all([
        getAllScreenshots(currentSessionId),
        getNetworkEvents(currentSessionId),
        getConsoleEvents(currentSessionId),
        getDOMEvents(currentSessionId),
        getSessionMetadata(currentSessionId),
      ]);

    // Guard: if no metadata found, the session data was likely cleared
    if (!rawMetadata) {
      showError('No session data found. The recording may have been cleared.');
      return;
    }

    // Build typed Screenshot array from storage result
    const screenshots: Screenshot[] = rawScreenshots.map((s, idx) => ({
      imageBlob: s.blob,
      timestamp: s.metadata.timestamp,
      videoTimestamp: s.metadata.videoTimestamp,
      annotationText: s.metadata.annotationText,
      index: idx,
    }));

    const networkEvents = rawNetworkEvents;
    const consoleEvents = rawConsoleEvents;
    const domEvents = rawDOMEvents;

    const metadata: SessionMetadata = rawMetadata;

    // Build replication steps from DOM events
    const sessionClock = createSessionClock(metadata.startTime);
    const replicationSteps = buildReplicationSteps(domEvents, sessionClock);

    const reportData: ReportData = {
      metadata,
      screenshots,
      networkEvents,
      consoleEvents,
      domEvents,
      replicationSteps,
    };

    const blob = await generateReport(reportData, {
      includeScreenshots: true,
      includeNetworkEvents: true,
      includeConsoleEvents: true,
      includeDOMEvents: true,
      includeReplicationSteps: true,
      maxNetworkEvents: 500,
      maxConsoleEvents: 200,
    });

    const filename = generateReportFilename(currentSessionId, metadata.startTime);
    await downloadReport(blob, filename);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError(`Report generation failed: ${message}`);
    console.error('Popup: Report generation error', err);
  } finally {
    reportBtn.disabled = false;
    reportBtn.textContent = 'Generate Report';
  }
}

// -----------------------------------------------------------------------
// UI state management
// -----------------------------------------------------------------------

function updateUIState(status: 'idle' | 'recording' | 'stopping' | 'starting' | 'completed' | 'error'): void {
  statusIndicator.className = `status-indicator ${status}`;

  switch (status) {
    case 'idle':
      statusText.textContent = 'Idle';
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      stopBtn.disabled = false;
      screenshotBtn.disabled = true;
      sessionInfo.classList.add('hidden');
      break;

    case 'starting':
      statusText.textContent = 'Starting...';
      startBtn.classList.add('hidden');
      stopBtn.classList.add('hidden');
      screenshotBtn.disabled = true;
      reportBtn.disabled = true;
      break;

    case 'recording':
      statusText.textContent = 'Recording';
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
      stopBtn.disabled = false;
      screenshotBtn.disabled = false;
      sessionInfo.classList.remove('hidden');
      reportBtn.disabled = true;
      break;

    case 'stopping':
      statusText.textContent = 'Stopping...';
      stopBtn.disabled = true;
      screenshotBtn.disabled = true;
      reportBtn.disabled = true;
      break;

    case 'completed':
      statusText.textContent = 'Session Complete';
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      stopBtn.disabled = false;
      screenshotBtn.disabled = true;
      sessionInfo.classList.add('hidden');
      reportBtn.disabled = !currentSessionId;
      break;

    case 'error':
      statusText.textContent = 'Error';
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      stopBtn.disabled = false;
      screenshotBtn.disabled = true;
      sessionInfo.classList.add('hidden');
      break;
  }
}

function updateEventCounts(
  chunkCount: number,
  screenshotCount: number,
  networkEventCount: number,
  consoleEventCount: number
): void {
  eventCountText.textContent = String(chunkCount);
  screenshotCountText.textContent = String(screenshotCount);
  networkCountText.textContent = String(networkEventCount);
  // Console events are not shown separately but are captured in event count
  void consoleEventCount;
}

function showError(message: string): void {
  if (errorTimeout) clearTimeout(errorTimeout);
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
  errorTimeout = setTimeout(() => {
    errorMessage.classList.add('hidden');
    errorTimeout = null;
  }, 5000);
}

// -----------------------------------------------------------------------
// Duration timer
// -----------------------------------------------------------------------

function startDurationTimer(): void {
  stopDurationTimer(); // Clear any existing timer
  durationTimer = setInterval(() => {
    if (recordingStartTime === null) return;
    const elapsed = Date.now() - recordingStartTime;
    const totalSeconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    durationText.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }, 1000);
}

function stopDurationTimer(): void {
  if (durationTimer !== null) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
}

// -----------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', initializeUI);

console.log('Popup script loaded');
