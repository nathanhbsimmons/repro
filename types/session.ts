// types/session.ts
// Session state management types

export interface SessionState {
  sessionId: string;
  tabId: number;
  status: 'idle' | 'recording' | 'stopping' | 'completed' | 'error';
  sessionStartTime: number; // T₀ timestamp (Date.now())
  sessionStopTime?: number;

  // Media state
  includeAudio: boolean;
  includeMicrophone: boolean;
  recordingChunkCount: number;
  screenshotCount: number;

  // Telemetry counts
  networkEventCount: number;
  consoleEventCount: number;
  domEventCount: number;

  // CDP state
  debuggerAttached: boolean;

  // Offscreen document state
  offscreenDocumentActive: boolean;

  // Error tracking
  lastError?: string;
  errorRecoverable?: boolean;
}

export interface SessionMetadata {
  sessionId: string;
  tabId: number;
  url: string;
  title: string;
  startTime: number;
  endTime?: number;
  duration?: number;
}

export interface SessionConfig {
  includeAudio: boolean;
  includeMicrophone: boolean;
  generateReport: boolean;
}
