// entrypoints/background.ts
// Service Worker (Background Script)
// Orchestrates recording sessions, manages offscreen document, CDP lifecycle, and message routing

import { MessageType, type RuntimeMessage } from '../types/messages';
import type { SessionState } from '../types/session';
import type { NetworkEvent, ConsoleEvent, DOMEvent, DOMEventMetadata } from '../types/telemetry';
import {
  updateScreenshotMetadata,
  storeNetworkEventBatch,
  storeConsoleEventBatch,
  storeDOMEventBatch,
  storeSerializedState,
  storeSessionMetadata,
} from '../lib/storage';
import { calculateVideoTimestamp, cdpWallTimeToVideoOffset } from '../lib/sync';
import { createCDPClient, registerCDPEventListeners } from '../lib/cdp-client';
import type {
  CDPNetworkRequestWillBeSentParams,
  CDPNetworkResponseReceivedParams,
  CDPNetworkLoadingFailedParams,
  CDPRuntimeConsoleAPICalledParams,
  CDPRuntimeExceptionThrownParams,
} from '../types/cdp';

export default defineBackground(() => {
  console.log('QA Companion - Background Service Worker initialized', {
    id: browser.runtime.id,
  });

  // Session state management (in-memory, ephemeral but sufficient per recording session)
  const sessions = new Map<string, SessionState>();

  // CDP client instance
  const cdpClient = createCDPClient();

  // CDP telemetry buffers (per session)
  const networkEventBuffers = new Map<string, NetworkEvent[]>();
  const consoleEventBuffers = new Map<string, ConsoleEvent[]>();
  const domEventBuffers = new Map<string, DOMEvent[]>();

  // Pending network requests (partial state until response received)
  const pendingNetworkRequests = new Map<
    string,
    Map<string, Partial<NetworkEvent>>
  >();

  // Buffer flush settings
  const BUFFER_FLUSH_SIZE = 50; // Flush after 50 events
  const BUFFER_FLUSH_INTERVAL_MS = 10000; // Flush every 10 seconds

  // Periodic buffer flush timers
  const flushTimers = new Map<string, ReturnType<typeof setInterval>>();

  // Batch indices for telemetry storage (per session)
  const networkBatchIndices = new Map<string, number>();
  const consoleBatchIndices = new Map<string, number>();
  const domBatchIndices = new Map<string, number>();

  // Flush-in-progress guard (per session)
  const flushInProgress = new Map<string, Promise<void>>();

  // Reverse index: tabId → sessionId for O(1) lookup in CDP event handlers
  const tabIdToSessionId = new Map<number, string>();

  // Sensitive headers that should be redacted
  const SENSITIVE_HEADERS = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-api-key',
    'x-auth-token',
  ]);

  // Sensitive cookie name pattern — matches auth tokens, session IDs, CSRF tokens, etc.
  const SENSITIVE_COOKIE_PATTERNS =
    /token|secret|password|passwd|auth|csrf|jwt|api[_-]?key|credential|session[_-]?id|private[_-]?key/i;

  /**
   * Sanitize sensitive headers (redact Authorization, Cookie, etc.)
   */
  function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  // Register CDP event listeners
  registerCDPEventListeners({
    onNetworkRequestWillBeSent: handleNetworkRequestWillBeSent,
    onNetworkResponse: handleNetworkResponse,
    onNetworkLoadingFailed: handleNetworkLoadingFailed,
    onConsoleAPICalled: handleConsoleAPICalled,
    onExceptionThrown: handleExceptionThrown,
    onDetach: handleCDPDetach,
  });

  // Message handlers
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch((error) => {
      console.error('Background: Message handler error', error);
      sendResponse({ success: false, error: String(error) });
    });
    return true; // Keep channel open for async response
  });

  /**
   * Main message router
   */
  async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
    console.log('Background: Received message', message.type, message.payload);

    switch (message.type) {
      case MessageType.START_RECORDING:
        return await handleStartRecording(message.payload);

      case MessageType.STOP_RECORDING:
        return await handleStopRecording(message.payload);

      case MessageType.TAKE_SCREENSHOT:
        return await handleTakeScreenshot(message.payload);

      case MessageType.GET_SESSION_STATUS:
        return await handleGetSessionStatus(message.payload);

      case MessageType.MEDIA_READY:
        return await handleMediaReady(message.payload);

      case MessageType.RECORDING_CHUNK:
        return await handleRecordingChunk(message.payload);

      case MessageType.SCREENSHOT_CAPTURED:
        return await handleScreenshotCaptured(message.payload);

      case MessageType.MEDIA_STOPPED:
        return await handleMediaStopped(message.payload);

      case MessageType.MEDIA_ERROR:
        return await handleMediaError(message.payload);

      case MessageType.DOM_EVENT_CAPTURED:
        return await handleDOMEventCaptured(message.payload);

      case MessageType.STATE_SERIALIZED:
        return await handleStateSerialized(message.payload);

      default:
        console.warn('Background: Unknown message type', message.type);
        return { success: false, error: 'Unknown message type' };
    }
  }

  /**
   * START_RECORDING handler
   */
  async function handleStartRecording(payload: {
    tabId: number;
    includeAudio: boolean;
    includeMicrophone: boolean;
  }): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    try {
      console.log('Background: Starting recording', payload);

      // 1. Capture T₀ = Date.now() as sessionStartTime
      const sessionStartTime = Date.now();
      const sessionId = `${payload.tabId}-${sessionStartTime}`;

      // 2. Get streamId for tab capture
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: payload.tabId,
      });

      console.log('Background: Got streamId', streamId);

      // 3. Create offscreen document if not exists
      await ensureOffscreenDocument();

      // 4. Create session state
      const sessionState: SessionState = {
        sessionId,
        tabId: payload.tabId,
        status: 'idle',
        sessionStartTime,
        includeAudio: payload.includeAudio,
        includeMicrophone: payload.includeMicrophone,
        recordingChunkCount: 0,
        screenshotCount: 0,
        networkEventCount: 0,
        consoleEventCount: 0,
        domEventCount: 0,
        debuggerAttached: false,
        offscreenDocumentActive: true,
      };

      sessions.set(sessionId, sessionState);
      tabIdToSessionId.set(payload.tabId, sessionId);

      console.log('Background: Session created', sessionId);

      // 5. Attach CDP debugger early (before media init) so the infobar banner
      // appears while popup is still in the "starting" state, not after recording begins
      try {
        console.log('Background: Attaching CDP debugger to tab', payload.tabId);
        await cdpClient.attach({ tabId: payload.tabId });
        await cdpClient.enableNetwork({ tabId: payload.tabId });
        await cdpClient.enableConsole({ tabId: payload.tabId });
        sessionState.debuggerAttached = true;
        console.log('Background: CDP debugger attached and domains enabled');
      } catch (error) {
        console.warn('Background: CDP debugger attach failed (non-blocking)', error);
        sessionState.debuggerAttached = false;
      }

      // 6. Forward INIT_MEDIA_CAPTURE to offscreen document
      await chrome.runtime.sendMessage({
        type: MessageType.INIT_MEDIA_CAPTURE,
        timestamp: Date.now(),
        payload: {
          tabId: payload.tabId,
          streamId: streamId,
          includeMicrophone: payload.includeMicrophone,
          sessionStartTime: sessionStartTime,
        },
      } satisfies RuntimeMessage);

      console.log('Background: INIT_MEDIA_CAPTURE sent to offscreen');

      return { success: true, sessionId };
    } catch (error) {
      console.error('Background: Error starting recording', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * STOP_RECORDING handler
   */
  async function handleStopRecording(payload: {
    tabId: number;
    generateReport: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('Background: Stopping recording', payload);

      // Find session by tabId
      const session = Array.from(sessions.values()).find(
        (s) => s.tabId === payload.tabId && s.status === 'recording'
      );

      if (!session) {
        throw new Error('No active recording session for this tab');
      }

      // Update session status
      session.status = 'stopping';
      session.sessionStopTime = Date.now();

      console.log('Background: Session status set to stopping', session.sessionId);

      // Send STOP_DOM_RECORDING to content script (non-blocking)
      try {
        await chrome.tabs.sendMessage(session.tabId, {
          type: MessageType.STOP_DOM_RECORDING,
          timestamp: Date.now(),
          payload: {
            sessionId: session.sessionId,
          },
        } satisfies RuntimeMessage);
        console.log('Background: STOP_DOM_RECORDING sent to content script');
      } catch (error) {
        console.warn('Background: Could not send STOP_DOM_RECORDING to content script', error);
      }

      // Forward STOP_MEDIA_CAPTURE to offscreen
      await chrome.runtime.sendMessage({
        type: MessageType.STOP_MEDIA_CAPTURE,
        timestamp: Date.now(),
        payload: {
          sessionId: session.sessionId,
        },
      } satisfies RuntimeMessage);

      console.log('Background: STOP_MEDIA_CAPTURE sent to offscreen');

      return { success: true };
    } catch (error) {
      console.error('Background: Error stopping recording', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * TAKE_SCREENSHOT handler
   */
  async function handleTakeScreenshot(payload: {
    tabId: number;
    annotationText?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('Background: Taking screenshot', payload);

      // Find session by tabId
      const session = Array.from(sessions.values()).find(
        (s) => s.tabId === payload.tabId && s.status === 'recording'
      );

      if (!session) {
        throw new Error('No active recording session for this tab');
      }

      // Forward CAPTURE_SCREENSHOT to offscreen
      await chrome.runtime.sendMessage({
        type: MessageType.CAPTURE_SCREENSHOT,
        timestamp: Date.now(),
        payload: {
          sessionId: session.sessionId,
        },
      } satisfies RuntimeMessage);

      console.log('Background: CAPTURE_SCREENSHOT sent to offscreen');

      return { success: true };
    } catch (error) {
      console.error('Background: Error taking screenshot', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * GET_SESSION_STATUS handler
   */
  async function handleGetSessionStatus(payload: {
    tabId: number;
  }): Promise<{ success: boolean; session?: Partial<SessionState>; error?: string }> {
    try {
      const session = Array.from(sessions.values()).find((s) => s.tabId === payload.tabId);

      if (!session) {
        // Check chrome.storage.local for a completed session
        try {
          const stored = await chrome.storage.local.get(`lastSession:${payload.tabId}`);
          const lastSession = stored[`lastSession:${payload.tabId}`] as
            | { sessionId: string; tabId: number; startTime: number }
            | undefined;
          if (lastSession) {
            return {
              success: true,
              session: {
                sessionId: lastSession.sessionId,
                tabId: lastSession.tabId,
                status: 'completed',
                sessionStartTime: lastSession.startTime,
              },
            };
          }
        } catch (error) {
          console.warn('Background: Error reading lastSession from storage.local', error);
        }

        return {
          success: true,
          session: {
            status: 'idle',
            tabId: payload.tabId,
          },
        };
      }

      return {
        success: true,
        session: {
          sessionId: session.sessionId,
          tabId: session.tabId,
          status: session.status,
          sessionStartTime: session.sessionStartTime,
          recordingChunkCount: session.recordingChunkCount,
          screenshotCount: session.screenshotCount,
          networkEventCount: session.networkEventCount,
          consoleEventCount: session.consoleEventCount,
        },
      };
    } catch (error) {
      console.error('Background: Error getting session status', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * MEDIA_READY handler (from offscreen)
   */
  async function handleMediaReady(payload: {
    sessionId: string;
    audioContext: { sampleRate: number; state: string };
    recorderState: string;
    micFailed?: boolean;
  }): Promise<{ success: boolean }> {
    console.log('Background: Media ready', payload);

    const session = sessions.get(payload.sessionId);
    if (session) {
      session.status = 'recording';

      // Initialize telemetry buffers for this session (CDP already attached in handleStartRecording)
      if (session.debuggerAttached) {
        networkEventBuffers.set(payload.sessionId, []);
        consoleEventBuffers.set(payload.sessionId, []);
        domEventBuffers.set(payload.sessionId, []);
        pendingNetworkRequests.set(payload.sessionId, new Map());

        // Initialize batch indices
        networkBatchIndices.set(payload.sessionId, 0);
        consoleBatchIndices.set(payload.sessionId, 0);
        domBatchIndices.set(payload.sessionId, 0);

        // Start periodic buffer flush timer
        const flushTimer = setInterval(() => {
          flushTelemetryBuffers(payload.sessionId);
        }, BUFFER_FLUSH_INTERVAL_MS);
        flushTimers.set(payload.sessionId, flushTimer);
      }

      // Start DOM recording in content script (non-blocking)
      try {
        await chrome.tabs.sendMessage(session.tabId, {
          type: MessageType.START_DOM_RECORDING,
          timestamp: Date.now(),
          payload: {
            sessionId: payload.sessionId,
            sessionStartTime: session.sessionStartTime,
          },
        } satisfies RuntimeMessage);
        console.log('Background: START_DOM_RECORDING sent to content script');
      } catch (error) {
        console.warn('Background: Could not send START_DOM_RECORDING to content script', error);
      }

      // Send status update to popup (may be closed, so wrap in try/catch)
      try {
        await chrome.runtime.sendMessage({
          type: MessageType.SESSION_STATUS_UPDATE,
          timestamp: Date.now(),
          payload: {
            tabId: session.tabId,
            status: 'recording',
            sessionId: session.sessionId,
            chunkCount: session.recordingChunkCount,
            screenshotCount: session.screenshotCount,
            networkEventCount: session.networkEventCount,
            consoleEventCount: session.consoleEventCount,
            micFailed: payload.micFailed,
          },
        } satisfies RuntimeMessage);
      } catch (error) {
        console.log('Background: Could not send status update to popup (likely closed)');
      }
    }

    return { success: true };
  }

  /**
   * RECORDING_CHUNK handler (from offscreen)
   * Offscreen document stores chunk directly to IndexedDB, we just update counters
   */
  async function handleRecordingChunk(payload: {
    sessionId: string;
    storageKey: string;
    chunkIndex: number;
    timestamp: number;
  }): Promise<{ success: boolean }> {
    try {
      console.log('Background: Chunk stored by offscreen', {
        sessionId: payload.sessionId,
        chunkIndex: payload.chunkIndex,
        storageKey: payload.storageKey,
      });

      // Update session state counter
      const session = sessions.get(payload.sessionId);
      if (session) {
        session.recordingChunkCount++;
      }

      return { success: true };
    } catch (error) {
      console.error('Background: Error updating chunk counter', error);
      return { success: false };
    }
  }

  /**
   * SCREENSHOT_CAPTURED handler (from offscreen)
   * Offscreen document stores screenshot directly to IndexedDB, we just update metadata and counters
   */
  async function handleScreenshotCaptured(payload: {
    sessionId: string;
    storageKey: string;
    screenshotIndex: number;
    timestamp: number;
    annotationText?: string;
  }): Promise<{ success: boolean }> {
    try {
      console.log('Background: Screenshot stored by offscreen', {
        sessionId: payload.sessionId,
        storageKey: payload.storageKey,
        screenshotIndex: payload.screenshotIndex,
      });

      const session = sessions.get(payload.sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      // Calculate video timestamp
      const videoTimestamp = calculateVideoTimestamp(
        session.sessionStartTime,
        payload.timestamp
      );

      // Update metadata in IndexedDB with calculated videoTimestamp (blob already stored by offscreen)
      await updateScreenshotMetadata(
        payload.sessionId,
        payload.screenshotIndex,
        {
          timestamp: payload.timestamp,
          videoTimestamp,
          annotationText: payload.annotationText,
        }
      );

      // Update session state
      session.screenshotCount++;

      console.log('Background: Screenshot metadata updated', {
        index: payload.screenshotIndex,
        videoTimestamp,
      });

      return { success: true };
    } catch (error) {
      console.error('Background: Error updating screenshot metadata', error);
      return { success: false };
    }
  }

  /**
   * MEDIA_STOPPED handler (from offscreen)
   */
  async function handleMediaStopped(payload: {
    sessionId: string;
    finalChunkCount: number;
  }): Promise<{ success: boolean }> {
    console.log('Background: Media stopped', payload);

    const session = sessions.get(payload.sessionId);
    if (session) {
      // Stop periodic flush timer
      const flushTimer = flushTimers.get(payload.sessionId);
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimers.delete(payload.sessionId);
      }

      // Request state serialization from content script (non-blocking)
      try {
        await chrome.tabs.sendMessage(session.tabId, {
          type: MessageType.SERIALIZE_STATE,
          timestamp: Date.now(),
          payload: {
            sessionId: payload.sessionId,
          },
        } satisfies RuntimeMessage);
        console.log('Background: SERIALIZE_STATE sent to content script');
      } catch (error) {
        console.warn('Background: Could not send SERIALIZE_STATE to content script', error);
      }

      // Final flush of telemetry buffers
      await flushTelemetryBuffers(payload.sessionId);

      // Detach CDP debugger
      if (session.debuggerAttached) {
        try {
          await cdpClient.detach({ tabId: session.tabId });
          session.debuggerAttached = false;
          console.log('Background: CDP debugger detached');
        } catch (error) {
          console.warn('Background: Error detaching CDP debugger', error);
        }
      }

      // Cleanup telemetry buffers and indices
      networkEventBuffers.delete(payload.sessionId);
      consoleEventBuffers.delete(payload.sessionId);
      domEventBuffers.delete(payload.sessionId);
      pendingNetworkRequests.delete(payload.sessionId);
      networkBatchIndices.delete(payload.sessionId);
      consoleBatchIndices.delete(payload.sessionId);
      domBatchIndices.delete(payload.sessionId);
      tabIdToSessionId.delete(session.tabId);

      session.status = 'completed';
      session.offscreenDocumentActive = false;

      // Store session metadata to IndexedDB (required for report generation)
      try {
        const tab = await chrome.tabs.get(session.tabId);
        await storeSessionMetadata(session.sessionId, {
          sessionId: session.sessionId,
          tabId: session.tabId,
          url: tab.url || 'unknown',
          title: tab.title || 'Untitled',
          startTime: session.sessionStartTime,
          endTime: session.sessionStopTime,
          duration: session.sessionStopTime
            ? session.sessionStopTime - session.sessionStartTime
            : undefined,
        });
        console.log('Background: Session metadata stored');
      } catch (error) {
        console.error('Background: Error storing session metadata', error);
      }

      // Persist completed session info to chrome.storage.local for popup recovery
      try {
        await chrome.storage.local.set({
          [`lastSession:${session.tabId}`]: {
            sessionId: session.sessionId,
            tabId: session.tabId,
            startTime: session.sessionStartTime,
          },
        });
        console.log('Background: Completed session persisted to storage.local');
      } catch (error) {
        console.error('Background: Error persisting completed session', error);
      }

      // Send status update to popup
      try {
        await chrome.runtime.sendMessage({
          type: MessageType.SESSION_STATUS_UPDATE,
          timestamp: Date.now(),
          payload: {
            tabId: session.tabId,
            status: 'completed',
            sessionId: session.sessionId,
            duration: session.sessionStopTime
              ? session.sessionStopTime - session.sessionStartTime
              : undefined,
            chunkCount: session.recordingChunkCount,
            screenshotCount: session.screenshotCount,
            networkEventCount: session.networkEventCount,
            consoleEventCount: session.consoleEventCount,
          },
        } satisfies RuntimeMessage);
      } catch (error) {
        console.log('Background: Could not send status update to popup (likely closed)');
      }
    }

    // Close offscreen document
    try {
      await chrome.offscreen.closeDocument();
      console.log('Background: Offscreen document closed');
    } catch (error) {
      console.error('Background: Error closing offscreen document', error);
    }

    return { success: true };
  }

  /**
   * MEDIA_ERROR handler (from offscreen)
   */
  async function handleMediaError(payload: {
    sessionId: string;
    error: string;
    stage: 'init' | 'recording' | 'stopping';
  }): Promise<{ success: boolean }> {
    console.error('Background: Media error', payload);

    const session = sessions.get(payload.sessionId);
    if (session) {
      session.status = 'error';
      session.lastError = payload.error;
      session.errorRecoverable = payload.stage !== 'init';

      // Clean up CDP if attached (for 'recording' or 'stopping' stage errors)
      if (session.debuggerAttached && (payload.stage === 'recording' || payload.stage === 'stopping')) {
        try {
          // Stop flush timer
          const timer = flushTimers.get(payload.sessionId);
          if (timer) {
            clearInterval(timer);
            flushTimers.delete(payload.sessionId);
          }

          // Final flush
          await flushTelemetryBuffers(payload.sessionId);

          // Detach CDP
          await cdpClient.detach({ tabId: session.tabId });
          session.debuggerAttached = false;

          console.log('Background: CDP cleaned up after media error');
        } catch (e) {
          console.error('Background: CDP cleanup on error failed', e);
        }

        // Clean buffers and indices
        networkEventBuffers.delete(payload.sessionId);
        consoleEventBuffers.delete(payload.sessionId);
        domEventBuffers.delete(payload.sessionId);
        pendingNetworkRequests.delete(payload.sessionId);
        networkBatchIndices.delete(payload.sessionId);
        consoleBatchIndices.delete(payload.sessionId);
        domBatchIndices.delete(payload.sessionId);
        tabIdToSessionId.delete(session.tabId);
      }

      // If error during init, close offscreen document to prevent blocking future recordings
      if (payload.stage === 'init') {
        try {
          await chrome.offscreen.closeDocument();
          session.offscreenDocumentActive = false;
          console.log('Background: Offscreen document closed after init error');
        } catch (error) {
          console.error('Background: Error closing offscreen document after init error', error);
        }
      }

      // Send error notification to popup
      try {
        await chrome.runtime.sendMessage({
          type: MessageType.RECORDING_ERROR,
          timestamp: Date.now(),
          payload: {
            tabId: session.tabId,
            error: payload.error,
            recoverable: session.errorRecoverable,
          },
        } satisfies RuntimeMessage);
      } catch (error) {
        console.log('Background: Could not send error to popup (likely closed)');
      }
    }

    return { success: true };
  }

  /**
   * Ensure offscreen document exists
   */
  async function ensureOffscreenDocument(): Promise<void> {
    try {
      // Check if offscreen document already exists
      const hasDocument = await chrome.offscreen.hasDocument();

      if (hasDocument) {
        console.log('Background: Offscreen document already exists');
        return;
      }

      // Create offscreen document
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.DISPLAY_MEDIA],
        justification: 'Recording tab video, system audio, and microphone audio with Web Audio API mixing',
      });

      console.log('Background: Offscreen document created');
    } catch (error) {
      console.error('Background: Error ensuring offscreen document', error);
      throw error;
    }
  }

  /**
   * CDP Event Handler: Network.requestWillBeSent
   */
  function handleNetworkRequestWillBeSent(
    tabId: number,
    params: CDPNetworkRequestWillBeSentParams
  ): void {
    // Find session for this tab (O(1) via reverse index)
    const sessionId = tabIdToSessionId.get(tabId);
    if (!sessionId) {
      return; // No active recording session for this tab
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'recording') {
      return;
    }

    const pendingRequests = pendingNetworkRequests.get(sessionId);
    if (!pendingRequests) {
      return;
    }

    // Create partial network event (sanitize headers)
    const partialEvent: Partial<NetworkEvent> = {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: sanitizeHeaders(params.request.headers),
      postData: params.request.postData,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
      videoTimestamp: cdpWallTimeToVideoOffset(params.wallTime, session.sessionStartTime),
    };

    // Store pending request
    pendingRequests.set(params.requestId, partialEvent);
  }

  /**
   * CDP Event Handler: Network.responseReceived
   */
  function handleNetworkResponse(
    tabId: number,
    params: CDPNetworkResponseReceivedParams
  ): void {
    // Find session for this tab (O(1) via reverse index)
    const sessionId = tabIdToSessionId.get(tabId);
    if (!sessionId) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'recording') {
      return;
    }

    const pendingRequests = pendingNetworkRequests.get(sessionId);
    if (!pendingRequests) {
      return;
    }

    // Get pending request
    const partialEvent = pendingRequests.get(params.requestId);
    if (!partialEvent) {
      console.warn('CDP: Response received for unknown request', params.requestId);
      return;
    }

    // Validate partial event has required fields before constructing NetworkEvent
    if (!partialEvent.requestId || !partialEvent.url || !partialEvent.method) {
      console.warn('CDP: Incomplete request for', params.requestId, '- skipping');
      pendingRequests.delete(params.requestId);
      return;
    }

    // Complete the network event with explicit field assignment (no unsafe spread)
    const completedEvent: NetworkEvent = {
      requestId: partialEvent.requestId,
      url: partialEvent.url,
      method: partialEvent.method,
      headers: partialEvent.headers || {},
      postData: partialEvent.postData,
      timestamp: partialEvent.timestamp || params.timestamp,
      wallTime: partialEvent.wallTime || 0,
      videoTimestamp: partialEvent.videoTimestamp || 0,
      status: params.response.status,
      statusText: params.response.statusText,
      responseHeaders: sanitizeHeaders(params.response.headers),
      mimeType: params.response.mimeType,
    };

    // Filter: Include XHR, Fetch, WebSocket, Document OR failed requests (status >= 400)
    const resourceType = params.type;
    const shouldInclude =
      resourceType === 'XHR' ||
      resourceType === 'Fetch' ||
      resourceType === 'WebSocket' ||
      resourceType === 'Document' ||
      (completedEvent.status && completedEvent.status >= 400);

    if (!shouldInclude) {
      // Exclude images, fonts, stylesheets, media (unless failed)
      pendingRequests.delete(params.requestId);
      return;
    }

    // TODO: Response body capture could be implemented in a future phase using a deferred pattern.
    // Current fire-and-forget approach wastes CDP calls for no benefit.

    // Add to buffer
    const buffer = networkEventBuffers.get(sessionId);
    if (buffer) {
      buffer.push(completedEvent);
      session.networkEventCount++;

      // Flush if buffer is full
      if (buffer.length >= BUFFER_FLUSH_SIZE) {
        flushTelemetryBuffers(sessionId).catch((error) => {
          console.error('CDP: Error flushing network events', error);
        });
      }
    }

    // Remove from pending
    pendingRequests.delete(params.requestId);
  }

  /**
   * CDP Event Handler: Network.loadingFailed
   */
  function handleNetworkLoadingFailed(
    tabId: number,
    params: CDPNetworkLoadingFailedParams
  ): void {
    // Find session for this tab (O(1) via reverse index)
    const sessionId = tabIdToSessionId.get(tabId);
    if (!sessionId) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'recording') {
      return;
    }

    const pendingRequests = pendingNetworkRequests.get(sessionId);
    if (!pendingRequests) {
      return;
    }

    // Get pending request
    const partialEvent = pendingRequests.get(params.requestId);
    if (!partialEvent) {
      console.warn('CDP: Loading failed for unknown request', params.requestId);
      return;
    }

    // Validate partial event has required fields
    if (!partialEvent.requestId || !partialEvent.url || !partialEvent.method) {
      console.warn('CDP: Incomplete request for', params.requestId, '- skipping');
      pendingRequests.delete(params.requestId);
      return;
    }

    // Mark as failed with explicit field assignment
    const failedEvent: NetworkEvent = {
      requestId: partialEvent.requestId,
      url: partialEvent.url,
      method: partialEvent.method,
      headers: partialEvent.headers || {},
      postData: partialEvent.postData,
      timestamp: partialEvent.timestamp || params.timestamp,
      wallTime: partialEvent.wallTime || 0,
      videoTimestamp: partialEvent.videoTimestamp || 0,
      status: 0, // Failed request has no status
      statusText: params.errorText,
    };

    // Add to buffer (always include failed requests)
    const buffer = networkEventBuffers.get(sessionId);
    if (buffer) {
      buffer.push(failedEvent);
      session.networkEventCount++;

      // Flush if buffer is full
      if (buffer.length >= BUFFER_FLUSH_SIZE) {
        flushTelemetryBuffers(sessionId).catch((error) => {
          console.error('CDP: Error flushing network events', error);
        });
      }
    }

    // Remove from pending
    pendingRequests.delete(params.requestId);
  }

  /**
   * CDP Event Handler: Runtime.consoleAPICalled
   */
  function handleConsoleAPICalled(
    tabId: number,
    params: CDPRuntimeConsoleAPICalledParams
  ): void {
    // Find session for this tab (O(1) via reverse index)
    const sessionId = tabIdToSessionId.get(tabId);
    if (!sessionId) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'recording') {
      return;
    }

    // Map CDP console type to our ConsoleEvent level
    let level: ConsoleEvent['level'];
    switch (params.type) {
      case 'warning':
        level = 'warn';
        break;
      case 'error':
        level = 'error';
        break;
      case 'info':
        level = 'info';
        break;
      case 'debug':
        level = 'debug';
        break;
      default:
        level = 'log';
    }

    // Extract text from args
    const text = params.args
      .map((arg) => {
        if (arg.value !== undefined) {
          return String(arg.value);
        }
        if (arg.description !== undefined) {
          return arg.description;
        }
        return `[${arg.type}]`;
      })
      .join(' ');

    // Use current wall time (Date.now()) since Runtime.consoleAPICalled doesn't provide wallTime
    const wallTime = Date.now();

    const consoleEvent: ConsoleEvent = {
      level,
      text,
      args: params.args.map((arg) => arg.value),
      stackTrace: params.stackTrace,
      timestamp: params.timestamp,
      wallTime,
      videoTimestamp: calculateVideoTimestamp(session.sessionStartTime, wallTime),
    };

    // Add to buffer
    const buffer = consoleEventBuffers.get(sessionId);
    if (buffer) {
      buffer.push(consoleEvent);
      session.consoleEventCount++;

      // Flush if buffer is full
      if (buffer.length >= BUFFER_FLUSH_SIZE) {
        flushTelemetryBuffers(sessionId).catch((error) => {
          console.error('CDP: Error flushing console events', error);
        });
      }
    }
  }

  /**
   * CDP Event Handler: Runtime.exceptionThrown
   */
  function handleExceptionThrown(
    tabId: number,
    params: CDPRuntimeExceptionThrownParams
  ): void {
    // Find session for this tab (O(1) via reverse index)
    const sessionId = tabIdToSessionId.get(tabId);
    if (!sessionId) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'recording') {
      return;
    }

    const wallTime = Date.now();

    const consoleEvent: ConsoleEvent = {
      level: 'error',
      text: params.exceptionDetails.text,
      stackTrace: params.exceptionDetails.stackTrace,
      timestamp: params.timestamp,
      wallTime,
      videoTimestamp: calculateVideoTimestamp(session.sessionStartTime, wallTime),
      url: params.exceptionDetails.url,
      lineNumber: params.exceptionDetails.lineNumber,
    };

    // Add to buffer
    const buffer = consoleEventBuffers.get(sessionId);
    if (buffer) {
      buffer.push(consoleEvent);
      session.consoleEventCount++;

      // Flush if buffer is full
      if (buffer.length >= BUFFER_FLUSH_SIZE) {
        flushTelemetryBuffers(sessionId).catch((error) => {
          console.error('CDP: Error flushing console events', error);
        });
      }
    }
  }

  /**
   * DOM_EVENT_CAPTURED handler (from content script)
   */
  async function handleDOMEventCaptured(payload: {
    sessionId: string;
    eventType: string;
    selector: string;
    timestamp: number;
    metadata?: DOMEventMetadata;
  }): Promise<{ success: boolean }> {
    try {
      const session = sessions.get(payload.sessionId);
      if (!session || session.status !== 'recording') {
        return { success: false };
      }

      // Calculate video timestamp
      const videoTimestamp = calculateVideoTimestamp(
        session.sessionStartTime,
        payload.timestamp
      );

      // Create DOMEvent
      const domEvent: DOMEvent = {
        eventType: payload.eventType,
        selector: payload.selector,
        timestamp: payload.timestamp,
        videoTimestamp,
        metadata: payload.metadata,
      };

      // Add to buffer
      const buffer = domEventBuffers.get(payload.sessionId);
      if (buffer) {
        buffer.push(domEvent);
        session.domEventCount++;

        // Flush if buffer is full
        if (buffer.length >= BUFFER_FLUSH_SIZE) {
          await flushTelemetryBuffers(payload.sessionId);
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Background: Error handling DOM event', error);
      return { success: false };
    }
  }

  /**
   * STATE_SERIALIZED handler (from content script)
   */
  async function handleStateSerialized(payload: {
    sessionId: string;
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      secure: boolean;
      httpOnly: boolean;
      sameSite?: string;
      expirationDate?: number;
    }>;
  }): Promise<{ success: boolean }> {
    try {
      console.log('Background: State serialized from content script', payload.sessionId);

      const session = sessions.get(payload.sessionId);
      if (!session) {
        return { success: false };
      }

      // Fetch cookies using chrome.cookies API (content script can't access this)
      let cookies: Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        secure: boolean;
        httpOnly: boolean;
        sameSite?: string;
        expirationDate?: number;
      }> = [];

      try {
        const tab = await chrome.tabs.get(session.tabId);
        if (tab.url) {
          const allCookies = await chrome.cookies.getAll({ url: tab.url });
          cookies = allCookies.map((cookie) => {
            // Redact httpOnly cookies entirely — they are inaccessible to JS anyway
            // and are typically session/auth cookies.
            if (cookie.httpOnly) {
              return {
                name: cookie.name,
                value: '[REDACTED - httpOnly]',
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                sameSite: cookie.sameSite,
                expirationDate: cookie.expirationDate,
              };
            }
            // Redact cookies whose names match sensitive patterns
            if (SENSITIVE_COOKIE_PATTERNS.test(cookie.name)) {
              return {
                name: cookie.name,
                value: '[REDACTED]',
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                sameSite: cookie.sameSite,
                expirationDate: cookie.expirationDate,
              };
            }
            return {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite,
              expirationDate: cookie.expirationDate,
            };
          });
        }
      } catch (error) {
        console.warn('Background: Could not fetch cookies', error);
      }

      // Store serialized state with cookies
      await storeSerializedState(payload.sessionId, {
        localStorage: payload.localStorage,
        sessionStorage: payload.sessionStorage,
        cookies,
      });

      console.log('Background: Serialized state stored', {
        sessionId: payload.sessionId,
        localStorageKeys: Object.keys(payload.localStorage).length,
        sessionStorageKeys: Object.keys(payload.sessionStorage).length,
        cookiesCount: cookies.length,
      });

      return { success: true };
    } catch (error) {
      console.error('Background: Error handling state serialized', error);
      return { success: false };
    }
  }

  /**
   * CDP Event Handler: chrome.debugger.onDetach
   */
  function handleCDPDetach(tabId: number, reason: string): void {
    // Find session for this tab (O(1) via reverse index)
    const sessionId = tabIdToSessionId.get(tabId);
    if (!sessionId) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'recording') {
      return;
    }

    console.warn(
      'CDP: Debugger detached externally for session',
      sessionId,
      'reason:',
      reason
    );
    session.debuggerAttached = false;

    // Don't stop recording - just log warning
    // User may have opened DevTools, which detaches our debugger
  }

  /**
   * Flush telemetry buffers to IndexedDB (with batch storage and TTL cleanup)
   */
  async function flushTelemetryBuffers(sessionId: string): Promise<void> {
    // Guard against concurrent flushes
    if (flushInProgress.has(sessionId)) {
      return flushInProgress.get(sessionId)!;
    }

    const promise = doFlushTelemetryBuffers(sessionId);
    flushInProgress.set(sessionId, promise);

    try {
      await promise;
    } finally {
      flushInProgress.delete(sessionId);
    }
  }

  /**
   * Internal flush implementation (called by flushTelemetryBuffers)
   */
  async function doFlushTelemetryBuffers(sessionId: string): Promise<void> {
    try {
      const networkBuffer = networkEventBuffers.get(sessionId);
      const consoleBuffer = consoleEventBuffers.get(sessionId);
      const domBuffer = domEventBuffers.get(sessionId);

      // Atomically extract events from buffers (before async operations)
      const networkEventsToFlush = networkBuffer && networkBuffer.length > 0
        ? networkBuffer.splice(0, networkBuffer.length)
        : [];
      const consoleEventsToFlush = consoleBuffer && consoleBuffer.length > 0
        ? consoleBuffer.splice(0, consoleBuffer.length)
        : [];
      const domEventsToFlush = domBuffer && domBuffer.length > 0
        ? domBuffer.splice(0, domBuffer.length)
        : [];

      // Flush network events to batch storage
      if (networkEventsToFlush.length > 0) {
        const batchIndex = networkBatchIndices.get(sessionId) || 0;
        await storeNetworkEventBatch(sessionId, batchIndex, networkEventsToFlush);
        networkBatchIndices.set(sessionId, batchIndex + 1);
        console.log(
          'CDP: Flushed',
          networkEventsToFlush.length,
          'network events to batch',
          batchIndex,
          'for session',
          sessionId
        );
      }

      // Flush console events to batch storage
      if (consoleEventsToFlush.length > 0) {
        const batchIndex = consoleBatchIndices.get(sessionId) || 0;
        await storeConsoleEventBatch(sessionId, batchIndex, consoleEventsToFlush);
        consoleBatchIndices.set(sessionId, batchIndex + 1);
        console.log(
          'CDP: Flushed',
          consoleEventsToFlush.length,
          'console events to batch',
          batchIndex,
          'for session',
          sessionId
        );
      }

      // Flush DOM events to batch storage
      if (domEventsToFlush.length > 0) {
        const batchIndex = domBatchIndices.get(sessionId) || 0;
        await storeDOMEventBatch(sessionId, batchIndex, domEventsToFlush);
        domBatchIndices.set(sessionId, batchIndex + 1);
        console.log(
          'Background: Flushed',
          domEventsToFlush.length,
          'DOM events to batch',
          batchIndex,
          'for session',
          sessionId
        );
      }

      // TTL cleanup for pendingNetworkRequests (2 minute TTL)
      const pendingMap = pendingNetworkRequests.get(sessionId);
      if (pendingMap) {
        const now = Date.now();
        for (const [requestId, partialEvent] of pendingMap) {
          // wallTime is in seconds, convert to ms for comparison
          const eventTimeMs = (partialEvent.wallTime || 0) * 1000;
          if (now - eventTimeMs > 120_000) { // 2 minutes TTL
            pendingMap.delete(requestId);
          }
        }
      }
    } catch (error) {
      console.error('CDP: Error flushing telemetry buffers', error);
      throw error;
    }
  }

  console.log('Background: Message handlers registered');
});
