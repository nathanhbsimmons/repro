// types/messages.ts
// Message-passing schema for QA Companion Extension
// All inter-component communication uses these typed messages

import type { DOMEventMetadata } from './telemetry';

export type MessageEnvelope<T extends MessageType> = {
  type: T;
  payload: MessagePayloads[T];
  timestamp: number; // Date.now()
  correlationId?: string; // For request/response pairing
};

export enum MessageType {
  // Popup → Background
  START_RECORDING = 'START_RECORDING',
  STOP_RECORDING = 'STOP_RECORDING',
  TAKE_SCREENSHOT = 'TAKE_SCREENSHOT',
  GET_SESSION_STATUS = 'GET_SESSION_STATUS',

  // Background → Offscreen
  INIT_MEDIA_CAPTURE = 'INIT_MEDIA_CAPTURE',
  STOP_MEDIA_CAPTURE = 'STOP_MEDIA_CAPTURE',
  CAPTURE_SCREENSHOT = 'CAPTURE_SCREENSHOT',

  // Offscreen → Background
  MEDIA_READY = 'MEDIA_READY',
  MEDIA_ERROR = 'MEDIA_ERROR',
  RECORDING_CHUNK = 'RECORDING_CHUNK',
  SCREENSHOT_CAPTURED = 'SCREENSHOT_CAPTURED',
  MEDIA_STOPPED = 'MEDIA_STOPPED',

  // Background → Content Script
  START_DOM_RECORDING = 'START_DOM_RECORDING',
  STOP_DOM_RECORDING = 'STOP_DOM_RECORDING',
  SERIALIZE_STATE = 'SERIALIZE_STATE',

  // Content Script → Background
  DOM_EVENT_CAPTURED = 'DOM_EVENT_CAPTURED',
  RRWEB_SNAPSHOT = 'RRWEB_SNAPSHOT',
  STATE_SERIALIZED = 'STATE_SERIALIZED',

  // Background → Popup
  SESSION_STATUS_UPDATE = 'SESSION_STATUS_UPDATE',
  RECORDING_ERROR = 'RECORDING_ERROR',

  // CDP Events (Background internal, but typed)
  CDP_NETWORK_REQUEST = 'CDP_NETWORK_REQUEST',
  CDP_CONSOLE_LOG = 'CDP_CONSOLE_LOG',
}

export interface MessagePayloads {
  // Popup → Background
  [MessageType.START_RECORDING]: {
    tabId: number;
    includeAudio: boolean;
    includeMicrophone: boolean;
  };
  [MessageType.STOP_RECORDING]: {
    tabId: number;
    generateReport: boolean;
  };
  [MessageType.TAKE_SCREENSHOT]: {
    tabId: number;
    annotationText?: string;
  };
  [MessageType.GET_SESSION_STATUS]: {
    tabId: number;
  };

  // Background → Offscreen
  [MessageType.INIT_MEDIA_CAPTURE]: {
    tabId: number;
    streamId: string; // From chrome.tabCapture.getMediaStreamId()
    includeMicrophone: boolean;
    sessionStartTime: number; // T₀ in milliseconds (Date.now())
  };
  [MessageType.STOP_MEDIA_CAPTURE]: {
    sessionId: string;
  };
  [MessageType.CAPTURE_SCREENSHOT]: {
    sessionId: string;
  };

  // Offscreen → Background
  [MessageType.MEDIA_READY]: {
    sessionId: string;
    audioContext: { sampleRate: number; state: string };
    recorderState: string;
    micFailed?: boolean;
  };
  [MessageType.MEDIA_ERROR]: {
    sessionId: string;
    error: string;
    stage: 'init' | 'recording' | 'stopping';
  };
  [MessageType.RECORDING_CHUNK]: {
    sessionId: string;
    storageKey: string; // IndexedDB key where chunk was stored
    chunkIndex: number;
    timestamp: number; // Wall time when chunk was emitted
  };
  [MessageType.SCREENSHOT_CAPTURED]: {
    sessionId: string;
    storageKey: string; // IndexedDB key where screenshot was stored
    screenshotIndex: number;
    timestamp: number;
    annotationText?: string;
  };
  [MessageType.MEDIA_STOPPED]: {
    sessionId: string;
    finalChunkCount: number;
  };

  // Background → Content Script
  [MessageType.START_DOM_RECORDING]: {
    sessionId: string;
    sessionStartTime: number;
  };
  [MessageType.STOP_DOM_RECORDING]: {
    sessionId: string;
  };
  [MessageType.SERIALIZE_STATE]: {
    sessionId: string;
  };

  // Content Script → Background
  [MessageType.DOM_EVENT_CAPTURED]: {
    sessionId: string;
    eventType: string;
    selector: string;
    timestamp: number;
    metadata?: DOMEventMetadata;
  };
  [MessageType.RRWEB_SNAPSHOT]: {
    sessionId: string;
    events: unknown[]; // rrweb event array
    batchIndex: number;
  };
  [MessageType.STATE_SERIALIZED]: {
    sessionId: string;
    localStorage: Record<string, string>;
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
    sessionStorage: Record<string, string>;
  };

  // Background → Popup
  [MessageType.SESSION_STATUS_UPDATE]: {
    tabId: number;
    status: 'idle' | 'recording' | 'stopping' | 'completed' | 'error';
    sessionId?: string;
    duration?: number; // milliseconds
    chunkCount?: number;
    screenshotCount?: number;
    networkEventCount?: number;
    consoleEventCount?: number;
    micFailed?: boolean;
  };
  [MessageType.RECORDING_ERROR]: {
    tabId: number;
    error: string;
    recoverable: boolean;
  };

  // CDP Events (Internal Background state)
  [MessageType.CDP_NETWORK_REQUEST]: {
    sessionId: string;
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    timestamp: number; // CDP timestamp (monotonic)
    wallTime: number; // CDP wallTime (UNIX timestamp)
  };
  [MessageType.CDP_CONSOLE_LOG]: {
    sessionId: string;
    level: 'log' | 'warn' | 'error' | 'info' | 'debug';
    text: string;
    args?: unknown[];
    stackTrace?: unknown;
    timestamp: number; // CDP timestamp
    wallTime: number;
  };
}

// Helper type for runtime message sending
export type RuntimeMessage = {
  [K in MessageType]: MessageEnvelope<K>;
}[MessageType];
