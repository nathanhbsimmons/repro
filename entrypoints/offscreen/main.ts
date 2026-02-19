// entrypoints/offscreen/main.ts
// Offscreen Document - Media Capture
// Handles tab video + mic audio capture, Web Audio routing, MediaRecorder lifecycle, screenshots

import { MessageType, type RuntimeMessage } from '../../types/messages';
import { storeChunk, storeScreenshot, createStorageKey } from '../../lib/storage';

console.log('QA Companion - Offscreen Document initialized');

// Chrome-specific constraint types for getUserMedia
interface ChromeTabConstraints {
  mandatory: {
    chromeMediaSource: string;
    chromeMediaSourceId: string;
  };
}

// ImageCapture API declaration (not in all TypeScript definitions)
declare class ImageCapture {
  constructor(track: MediaStreamTrack);
  grabFrame(): Promise<ImageBitmap>;
}

// MediaRecorder error event type
interface MediaRecorderErrorEvent extends Event {
  error?: Error;
}

// Media capture state
let audioContext: AudioContext | null = null;
let mediaRecorder: MediaRecorder | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let sessionId: string | null = null;
let chunkIndex = 0;
let screenshotIndex = 0;

// Audio routing nodes
let tabSourceNode: MediaStreamAudioSourceNode | null = null;
let micSourceNode: MediaStreamAudioSourceNode | null = null;
let tabGainNode: GainNode | null = null;
let micGainNode: GainNode | null = null;
let destinationStream: MediaStreamAudioDestinationNode | null = null;

// Message handlers
chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case MessageType.INIT_MEDIA_CAPTURE:
          await initMediaCapture(message.payload);
          break;
        case MessageType.STOP_MEDIA_CAPTURE:
          await stopMediaCapture();
          break;
        case MessageType.CAPTURE_SCREENSHOT:
          await captureScreenshot(message.payload.sessionId);
          break;
        default:
          console.warn('Offscreen: Unknown message type', message.type);
      }
      sendResponse({ success: true });
    } catch (error) {
      console.error('Offscreen: Message handler error', error);
      sendResponse({ success: false, error: String(error) });
    }
  })();
  return true; // Keep channel open for async response
});

/**
 * Initialize media capture
 * 1. Get tab stream using streamId from chrome.tabCapture.getMediaStreamId()
 * 2. Get microphone stream if requested
 * 3. Set up Web Audio API routing:
 *    - Tab audio -> speakers (audioContext.destination)
 *    - Tab audio -> MediaStreamDestination -> recorder
 *    - Mic audio -> MediaStreamDestination -> recorder (NOT to speakers to prevent echo)
 * 4. Create MediaRecorder with merged stream
 * 5. Send MEDIA_READY message to background
 */
async function initMediaCapture(payload: {
  tabId: number;
  streamId: string;
  includeMicrophone: boolean;
  sessionStartTime: number;
}): Promise<void> {
  try {
    console.log('Offscreen: Initializing media capture', payload);

    // Generate sessionId from tabId and timestamp
    sessionId = `${payload.tabId}-${payload.sessionStartTime}`;
    chunkIndex = 0;
    screenshotIndex = 0;

    // 1. Get tab stream using the streamId
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: payload.streamId,
        },
      } as unknown as MediaTrackConstraints,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: payload.streamId,
        },
      } as unknown as MediaTrackConstraints,
    });

    console.log('Offscreen: Tab stream acquired', {
      audioTracks: tabStream.getAudioTracks().length,
      videoTracks: tabStream.getVideoTracks().length,
    });

    // 2. Get microphone stream if requested
    let micFailed = false;
    if (payload.includeMicrophone) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('Offscreen: Microphone stream acquired');
      } catch (micError) {
        console.warn('Offscreen: Microphone access failed, continuing without mic', micError);
        micStream = null;
        micFailed = true;
      }
    }

    // 3. Set up Web Audio API routing
    // IMPORTANT: Use 48kHz sample rate to prevent audio drift
    audioContext = new AudioContext({ sampleRate: 48000 });
    const tabAudioTrack = tabStream.getAudioTracks()[0];

    // NOTE: When using chrome.tabCapture with chromeMediaSource: 'tab',
    // Chrome natively continues playing the tab audio to speakers.
    // We do NOT need to route audioContext.destination in the offscreen document
    // as that would be a no-op (offscreen has no audio output device).
    // We only need to route audio to the MediaStreamDestination for recording.

    if (tabAudioTrack) {
      // Create source from tab audio
      tabSourceNode = audioContext.createMediaStreamSource(
        new MediaStream([tabAudioTrack])
      );
      tabGainNode = audioContext.createGain();
      tabGainNode.gain.value = 1.0;
      tabSourceNode.connect(tabGainNode);

      console.log('Offscreen: Tab audio source created (tab audio plays natively)');
    }

    // Create destination stream for recorder
    destinationStream = audioContext.createMediaStreamDestination();

    // Route tab audio to recorder (via gain node)
    if (tabGainNode) {
      tabGainNode.connect(destinationStream);
    }

    // Route microphone to recorder only (NOT to speakers to avoid echo/feedback)
    if (micStream) {
      const micAudioTrack = micStream.getAudioTracks()[0];
      if (micAudioTrack) {
        micSourceNode = audioContext.createMediaStreamSource(
          new MediaStream([micAudioTrack])
        );
        micGainNode = audioContext.createGain();
        micGainNode.gain.value = 1.0;
        micSourceNode.connect(micGainNode);
        micGainNode.connect(destinationStream);

        console.log('Offscreen: Microphone audio routed to recorder only');
      }
    }

    // 4. Get video track from tab stream and merge with audio
    const videoTrack = tabStream.getVideoTracks()[0];
    const mergedStream = new MediaStream([
      videoTrack,
      ...destinationStream.stream.getAudioTracks(),
    ]);

    console.log('Offscreen: Merged stream created', {
      audioTracks: mergedStream.getAudioTracks().length,
      videoTracks: mergedStream.getVideoTracks().length,
    });

    // 5. Create MediaRecorder with best available codec
    let mimeType = 'video/webm;codecs=vp9,opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm;codecs=vp8,opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm';
      }
    }

    console.log('Offscreen: Using mimeType', mimeType);

    mediaRecorder = new MediaRecorder(mergedStream, { mimeType });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        sendChunkToBackground(event.data);
      }
    };

    mediaRecorder.onerror = (event) => {
      const errorEvent = event as MediaRecorderErrorEvent;
      const errorMessage = errorEvent.error?.message || 'unknown MediaRecorder error';
      console.error('Offscreen: MediaRecorder error', errorMessage);
      sendMediaError('recording', `MediaRecorder error: ${errorMessage}`);
    };

    mediaRecorder.start(1000); // Emit chunks every 1 second

    console.log('Offscreen: MediaRecorder started');

    // 6. Send MEDIA_READY message to background
    await chrome.runtime.sendMessage({
      type: MessageType.MEDIA_READY,
      timestamp: Date.now(),
      payload: {
        sessionId: sessionId,
        audioContext: {
          sampleRate: audioContext.sampleRate,
          state: audioContext.state,
        },
        recorderState: mediaRecorder.state,
        micFailed,
      },
    } satisfies RuntimeMessage);

    console.log('Offscreen: MEDIA_READY sent to background');
  } catch (error) {
    console.error('Offscreen: Error initializing media capture', error);
    sendMediaError('init', String(error));
    throw error;
  }
}

/**
 * Stop media capture and clean up resources
 */
async function stopMediaCapture(): Promise<void> {
  try {
    console.log('Offscreen: Stopping media capture');

    const finalChunkCount = chunkIndex;
    const currentSessionId = sessionId;

    // 1. Stop MediaRecorder and wait for final dataavailable or stop event
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        if (!mediaRecorder) {
          resolve();
          return;
        }

        let resolved = false;
        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          mediaRecorder?.removeEventListener('dataavailable', handleFinalData);
          mediaRecorder?.removeEventListener('stop', handleStop);
          clearTimeout(timeout);
          resolve();
        };

        const handleFinalData = () => {
          console.log('Offscreen: Final dataavailable event received');
          cleanup();
        };

        const handleStop = () => {
          console.log('Offscreen: MediaRecorder stop event received');
          cleanup();
        };

        // 5-second timeout as safety net
        const timeout = setTimeout(() => {
          console.warn('Offscreen: MediaRecorder stop timeout (5s), forcing cleanup');
          cleanup();
        }, 5000);

        mediaRecorder.addEventListener('dataavailable', handleFinalData);
        mediaRecorder.addEventListener('stop', handleStop);
        mediaRecorder.stop();
      });

      console.log('Offscreen: MediaRecorder stopped');
    }

    // 2. Disconnect all audio nodes
    tabSourceNode?.disconnect();
    micSourceNode?.disconnect();
    tabGainNode?.disconnect();
    micGainNode?.disconnect();
    destinationStream?.disconnect();

    // 3. Stop all tracks
    tabStream?.getTracks().forEach((track) => {
      track.stop();
      console.log('Offscreen: Stopped tab track', track.kind);
    });
    micStream?.getTracks().forEach((track) => {
      track.stop();
      console.log('Offscreen: Stopped mic track', track.kind);
    });

    // 4. Close AudioContext
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close();
      console.log('Offscreen: AudioContext closed');
    }

    // 5. Reset state
    audioContext = null;
    mediaRecorder = null;
    tabStream = null;
    micStream = null;
    tabSourceNode = null;
    micSourceNode = null;
    tabGainNode = null;
    micGainNode = null;
    destinationStream = null;

    // 6. Send MEDIA_STOPPED message to background
    await chrome.runtime.sendMessage({
      type: MessageType.MEDIA_STOPPED,
      timestamp: Date.now(),
      payload: {
        sessionId: currentSessionId!,
        finalChunkCount: finalChunkCount,
      },
    } satisfies RuntimeMessage);

    console.log('Offscreen: MEDIA_STOPPED sent to background', {
      finalChunkCount,
    });

    // Reset session tracking
    sessionId = null;
    chunkIndex = 0;
    screenshotIndex = 0;
  } catch (error) {
    console.error('Offscreen: Error stopping media capture', error);
    sendMediaError('stopping', String(error));
    throw error;
  }
}

/**
 * Capture a screenshot using ImageCapture API
 */
async function captureScreenshot(requestSessionId: string): Promise<void> {
  try {
    console.log('Offscreen: Capturing screenshot');

    // Validate we're recording
    if (!tabStream || !sessionId) {
      throw new Error('Not recording - no active tab stream');
    }

    // 1. Get video track from tab stream
    const videoTrack = tabStream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') {
      throw new Error('Video track not available or ended');
    }

    // 2. Use ImageCapture API to grab a frame
    const imageCapture = new ImageCapture(videoTrack);
    const imageBitmap = await imageCapture.grabFrame();

    let blob: Blob;
    try {
      // 3. Convert ImageBitmap to Blob via OffscreenCanvas
      const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to get canvas context');
      }

      ctx.drawImage(imageBitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: 'image/png' });

      console.log('Offscreen: Screenshot captured', {
        width: imageBitmap.width,
        height: imageBitmap.height,
        size: blob.size,
      });
    } finally {
      // CRITICAL: Close ImageBitmap to release GPU resources
      imageBitmap.close();
    }

    // 4. Store screenshot directly to IndexedDB (avoid binary message passing)
    const currentScreenshotIndex = screenshotIndex++;
    const timestamp = Date.now();
    const storageKey = createStorageKey(sessionId, 'screenshot', currentScreenshotIndex);

    // Store with minimal metadata (videoTimestamp will be calculated in background)
    await storeScreenshot(sessionId, currentScreenshotIndex, blob, {
      timestamp,
      videoTimestamp: 0, // Will be calculated in background using sessionStartTime
      annotationText: undefined,
    });

    console.log('Offscreen: Screenshot stored to IndexedDB', { storageKey, currentScreenshotIndex });

    // 5. Send lightweight SCREENSHOT_CAPTURED message to background (no binary data)
    await chrome.runtime.sendMessage({
      type: MessageType.SCREENSHOT_CAPTURED,
      timestamp: timestamp,
      payload: {
        sessionId: sessionId,
        storageKey: storageKey,
        screenshotIndex: currentScreenshotIndex,
        timestamp: timestamp,
      },
    } satisfies RuntimeMessage);

    console.log('Offscreen: SCREENSHOT_CAPTURED message sent to background');
  } catch (error) {
    console.error('Offscreen: Error capturing screenshot', error);
    sendMediaError('recording', `Screenshot error: ${error}`);
    throw error;
  }
}

/**
 * Store recording chunk directly to IndexedDB and notify background
 */
async function sendChunkToBackground(chunk: Blob): Promise<void> {
  try {
    if (!sessionId) {
      console.error('Offscreen: Cannot store chunk - no active session');
      return;
    }

    const currentChunkIndex = chunkIndex++;
    const timestamp = Date.now();

    console.log('Offscreen: Storing chunk to IndexedDB', {
      size: chunk.size,
      chunkIndex: currentChunkIndex,
    });

    // Store chunk directly to IndexedDB (no binary data through messages)
    const storageKey = createStorageKey(sessionId, 'chunk', currentChunkIndex);
    await storeChunk(sessionId, currentChunkIndex, chunk);

    console.log('Offscreen: Chunk stored', { storageKey });

    // Send lightweight RECORDING_CHUNK message to background (no binary data)
    await chrome.runtime.sendMessage({
      type: MessageType.RECORDING_CHUNK,
      timestamp: timestamp,
      payload: {
        sessionId: sessionId,
        storageKey: storageKey,
        chunkIndex: currentChunkIndex,
        timestamp: timestamp,
      },
    } satisfies RuntimeMessage);
  } catch (error) {
    console.error('Offscreen: Error storing chunk', error);
    // Don't throw - recording should continue even if one chunk fails
  }
}

/**
 * Send MEDIA_ERROR message to background
 */
async function sendMediaError(stage: 'init' | 'recording' | 'stopping', error: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: MessageType.MEDIA_ERROR,
      timestamp: Date.now(),
      payload: {
        sessionId: sessionId || 'unknown',
        error: error,
        stage: stage,
      },
    } satisfies RuntimeMessage);
  } catch (err) {
    console.error('Offscreen: Failed to send MEDIA_ERROR', err);
  }
}

console.log('Offscreen Document: Media capture handlers ready');
