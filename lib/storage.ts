// lib/storage.ts
// IndexedDB storage wrapper using idb-keyval
// Key schema: ${sessionId}:${type}:${index}

import { get, set, del, keys, clear } from 'idb-keyval';
import type { NetworkEvent, ConsoleEvent, DOMEvent } from '../types/telemetry';
import type { SessionMetadata } from '../types/session';

// Storage key types
export type StorageKeyType =
  | 'chunk'
  | 'screenshot'
  | 'network'
  | 'console'
  | 'dom'
  | 'rrweb'
  | 'metadata'
  | 'state';

/**
 * Generate a storage key following the schema: ${sessionId}:${type}:${index}
 */
export function createStorageKey(
  sessionId: string,
  type: StorageKeyType,
  index?: number
): string {
  if (index !== undefined) {
    return `${sessionId}:${type}:${index}`;
  }
  return `${sessionId}:${type}`;
}

/**
 * Store a recording chunk (Blob)
 */
export async function storeChunk(
  sessionId: string,
  chunkIndex: number,
  chunk: Blob
): Promise<void> {
  const key = createStorageKey(sessionId, 'chunk', chunkIndex);
  await set(key, chunk);
}

/**
 * Store a screenshot (Blob)
 */
export async function storeScreenshot(
  sessionId: string,
  screenshotIndex: number,
  imageBlob: Blob,
  metadata: { timestamp: number; videoTimestamp: number; annotationText?: string }
): Promise<void> {
  const imageKey = createStorageKey(sessionId, 'screenshot', screenshotIndex);
  const metadataKey = `${imageKey}:metadata`;

  await set(imageKey, imageBlob);
  await set(metadataKey, metadata);
}

/**
 * Update screenshot metadata without modifying the blob
 */
export async function updateScreenshotMetadata(
  sessionId: string,
  screenshotIndex: number,
  metadata: { timestamp: number; videoTimestamp: number; annotationText?: string }
): Promise<void> {
  const imageKey = createStorageKey(sessionId, 'screenshot', screenshotIndex);
  const metadataKey = `${imageKey}:metadata`;
  await set(metadataKey, metadata);
}

/**
 * Store network events batch (replaces O(n²) append pattern with O(n))
 * Each flush writes only NEW events to a new batch key
 */
export async function storeNetworkEventBatch(
  sessionId: string,
  batchIndex: number,
  events: NetworkEvent[]
): Promise<void> {
  const key = `${sessionId}:network:batch:${batchIndex}`;
  await set(key, events);
}

/**
 * Store console events batch (replaces O(n²) append pattern with O(n))
 * Each flush writes only NEW events to a new batch key
 */
export async function storeConsoleEventBatch(
  sessionId: string,
  batchIndex: number,
  events: ConsoleEvent[]
): Promise<void> {
  const key = `${sessionId}:console:batch:${batchIndex}`;
  await set(key, events);
}

/**
 * Store DOM events batch (replaces O(n²) append pattern with O(n))
 * Each flush writes only NEW events to a new batch key
 */
export async function storeDOMEventBatch(
  sessionId: string,
  batchIndex: number,
  events: DOMEvent[]
): Promise<void> {
  const key = `${sessionId}:dom:batch:${batchIndex}`;
  await set(key, events);
}

/**
 * Store DOM events (JSON array) - Deprecated, use storeDOMEventBatch instead
 */
export async function storeDOMEvents(
  sessionId: string,
  events: DOMEvent[]
): Promise<void> {
  const key = createStorageKey(sessionId, 'dom');
  await set(key, events);
}

/**
 * Store rrweb events (JSON array, may be large)
 */
export async function storeRRWebEvents(
  sessionId: string,
  events: unknown[]
): Promise<void> {
  const key = createStorageKey(sessionId, 'rrweb');
  await set(key, events);
}

/**
 * Store session metadata
 */
export async function storeSessionMetadata(
  sessionId: string,
  metadata: SessionMetadata
): Promise<void> {
  const key = createStorageKey(sessionId, 'metadata');
  await set(key, metadata);
}

/**
 * Retrieve all chunks for a session (sorted numerically by chunk index)
 */
export async function getAllChunks(sessionId: string): Promise<Blob[]> {
  const allKeys = await keys();
  const chunkKeys = allKeys.filter((key) =>
    String(key).startsWith(`${sessionId}:chunk:`)
  );

  // Sort chunk keys numerically by index (not lexicographically)
  chunkKeys.sort((a, b) => {
    const indexA = parseInt(String(a).split(':').pop() || '0', 10);
    const indexB = parseInt(String(b).split(':').pop() || '0', 10);
    return indexA - indexB;
  });

  const chunks: Blob[] = [];
  for (const key of chunkKeys) {
    const chunk = await get<Blob>(key);
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

/**
 * Retrieve all screenshots for a session (sorted numerically by screenshot index)
 */
export async function getAllScreenshots(sessionId: string): Promise<
  Array<{
    blob: Blob;
    metadata: { timestamp: number; videoTimestamp: number; annotationText?: string };
  }>
> {
  const allKeys = await keys();
  const screenshotKeys = allKeys.filter(
    (key) =>
      String(key).startsWith(`${sessionId}:screenshot:`) &&
      !String(key).endsWith(':metadata')
  );

  // Sort screenshot keys numerically by index (not lexicographically)
  screenshotKeys.sort((a, b) => {
    const indexA = parseInt(String(a).split(':').pop() || '0', 10);
    const indexB = parseInt(String(b).split(':').pop() || '0', 10);
    return indexA - indexB;
  });

  const screenshots: Array<{
    blob: Blob;
    metadata: { timestamp: number; videoTimestamp: number; annotationText?: string };
  }> = [];

  for (const key of screenshotKeys) {
    const blob = await get<Blob>(key);
    const metadata = await get<{
      timestamp: number;
      videoTimestamp: number;
      annotationText?: string;
    }>(`${key}:metadata`);

    if (blob && metadata) {
      screenshots.push({ blob, metadata });
    }
  }

  return screenshots;
}

/**
 * Retrieve network events (reads all batches, concatenates them)
 */
export async function getNetworkEvents(sessionId: string): Promise<NetworkEvent[]> {
  const allKeys = await keys();
  const batchKeys = allKeys.filter((key) =>
    String(key).startsWith(`${sessionId}:network:batch:`)
  );

  // Sort batch keys numerically by batch index
  batchKeys.sort((a, b) => {
    const indexA = parseInt(String(a).split(':').pop() || '0', 10);
    const indexB = parseInt(String(b).split(':').pop() || '0', 10);
    return indexA - indexB;
  });

  const allEvents: NetworkEvent[] = [];
  for (const key of batchKeys) {
    const batch = await get<NetworkEvent[]>(key);
    if (batch) {
      allEvents.push(...batch);
    }
  }

  return allEvents;
}

/**
 * Retrieve console events (reads all batches, concatenates them)
 */
export async function getConsoleEvents(sessionId: string): Promise<ConsoleEvent[]> {
  const allKeys = await keys();
  const batchKeys = allKeys.filter((key) =>
    String(key).startsWith(`${sessionId}:console:batch:`)
  );

  // Sort batch keys numerically by batch index
  batchKeys.sort((a, b) => {
    const indexA = parseInt(String(a).split(':').pop() || '0', 10);
    const indexB = parseInt(String(b).split(':').pop() || '0', 10);
    return indexA - indexB;
  });

  const allEvents: ConsoleEvent[] = [];
  for (const key of batchKeys) {
    const batch = await get<ConsoleEvent[]>(key);
    if (batch) {
      allEvents.push(...batch);
    }
  }

  return allEvents;
}

/**
 * Retrieve DOM events (reads all batches, concatenates them)
 */
export async function getDOMEvents(sessionId: string): Promise<DOMEvent[]> {
  const allKeys = await keys();
  const batchKeys = allKeys.filter((key) =>
    String(key).startsWith(`${sessionId}:dom:batch:`)
  );

  // Sort batch keys numerically by batch index
  batchKeys.sort((a, b) => {
    const indexA = parseInt(String(a).split(':').pop() || '0', 10);
    const indexB = parseInt(String(b).split(':').pop() || '0', 10);
    return indexA - indexB;
  });

  const allEvents: DOMEvent[] = [];
  for (const key of batchKeys) {
    const batch = await get<DOMEvent[]>(key);
    if (batch) {
      allEvents.push(...batch);
    }
  }

  // Fallback: check for legacy single-key storage
  if (allEvents.length === 0) {
    const legacyKey = createStorageKey(sessionId, 'dom');
    const legacyEvents = await get<DOMEvent[]>(legacyKey);
    if (legacyEvents) {
      return legacyEvents;
    }
  }

  return allEvents;
}

/**
 * Retrieve rrweb events
 */
export async function getRRWebEvents(sessionId: string): Promise<unknown[]> {
  const key = createStorageKey(sessionId, 'rrweb');
  return (await get<unknown[]>(key)) || [];
}

/**
 * Retrieve session metadata
 */
export async function getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  const key = createStorageKey(sessionId, 'metadata');
  return (await get<SessionMetadata>(key)) ?? null;
}

/**
 * Store serialized state (localStorage, sessionStorage, cookies snapshot)
 */
export async function storeSerializedState(
  sessionId: string,
  state: {
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
  }
): Promise<void> {
  const key = createStorageKey(sessionId, 'state');
  await set(key, state);
}

/**
 * Retrieve serialized state
 */
export async function getSerializedState(sessionId: string): Promise<{
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
} | null> {
  const key = createStorageKey(sessionId, 'state');
  return (await get(key)) || null;
}

/**
 * Delete all data for a session (cleanup after report generation)
 */
export async function deleteSessionData(sessionId: string): Promise<void> {
  const allKeys = await keys();
  const sessionKeys = allKeys.filter((key) => String(key).startsWith(`${sessionId}:`));

  for (const key of sessionKeys) {
    await del(key);
  }
}

/**
 * Clear all storage (use with caution)
 */
export async function clearAllStorage(): Promise<void> {
  await clear();
}
