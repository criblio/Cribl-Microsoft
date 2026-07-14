// Event Bus - Replaces Electron's WebContents.send() for server->client push events.
// Used by modules that broadcast progress (registry sync, change detection, etc.)

import { EventEmitter } from 'events';

export interface EventBus extends EventEmitter {
  push(channel: string, data: unknown): void;
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter() as EventBus;
  emitter.setMaxListeners(50);

  emitter.push = (channel: string, data: unknown) => {
    emitter.emit('push', { channel, data });
  };

  return emitter;
}

// Fake Electron WebContents that routes send() calls to the event bus.
// This lets existing IPC handlers use sender.send() without modification.
export function createFakeSender(eventBus: EventBus): Electron.WebContents {
  return {
    send(channel: string, ...args: unknown[]) {
      eventBus.push(channel, args.length === 1 ? args[0] : args);
    },
    isDestroyed() { return false; },
  } as unknown as Electron.WebContents;
}

// Fake IpcMainInvokeEvent that satisfies the handler signature
export function createFakeEvent(eventBus: EventBus): Electron.IpcMainInvokeEvent {
  return {
    sender: createFakeSender(eventBus),
    processId: process.pid,
    frameId: 0,
    senderFrame: {} as any,
  } as Electron.IpcMainInvokeEvent;
}
