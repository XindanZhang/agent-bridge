import type { BridgeMessage, FrontendIdentity } from "./types";

export class FrontendRegistry<T> {
  constructor(private readonly maxPendingMessages = Number.POSITIVE_INFINITY) {}

  private entries = new Map<string, { identity: FrontendIdentity; socket: T | null; pending: BridgeMessage[] }>();

  get(identityId: string) {
    return this.entries.get(identityId);
  }

  attach(identity: FrontendIdentity, socket: T) {
    const existing = this.entries.get(identity.id);
    if (existing) {
      existing.identity = identity;
      existing.socket = socket;
      return;
    }

    this.entries.set(identity.id, { identity, socket, pending: [] });
  }

  detach(identityId: string) {
    const existing = this.entries.get(identityId);
    if (!existing) return;
    existing.socket = null;
  }

  list() {
    return [...this.entries.values()].map(({ identity, socket }) => ({ identity, socket }));
  }

  connectedEntries() {
    return this.list().filter((entry) => entry.socket);
  }

  connectedCount() {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.socket) count++;
    }
    return count;
  }

  hasConnectedFrontends() {
    return this.connectedCount() > 0;
  }

  pendingCount() {
    let count = 0;
    for (const entry of this.entries.values()) {
      count += entry.pending.length;
    }
    return count;
  }

  getPending(identityId: string) {
    return this.entries.get(identityId)?.pending ?? [];
  }

  flushPending(identityId: string, send: (socket: T, message: BridgeMessage) => boolean) {
    const entry = this.entries.get(identityId);
    if (!entry?.socket || entry.pending.length === 0) return;
    this.flushEntry(entry, send);
  }

  broadcast(message: BridgeMessage, send: (socket: T, message: BridgeMessage) => boolean) {
    for (const entry of this.entries.values()) {
      this.deliverOrQueue(entry, message, send);
    }
  }

  broadcastExcept(identityId: string, message: BridgeMessage, send: (socket: T, message: BridgeMessage) => boolean) {
    for (const [entryId, entry] of this.entries.entries()) {
      if (entryId === identityId) continue;
      this.deliverOrQueue(entry, message, send);
    }
  }

  private deliverOrQueue(
    entry: { identity: FrontendIdentity; socket: T | null; pending: BridgeMessage[] },
    message: BridgeMessage,
    send: (socket: T, message: BridgeMessage) => boolean,
  ) {
    if (!entry.socket) {
      this.enqueuePending(entry, message);
      return;
    }

    if (entry.pending.length > 0) {
      this.enqueuePending(entry, message);
      this.flushEntry(entry, send);
      return;
    }

    if (send(entry.socket, message)) return;
    this.enqueuePending(entry, message);
  }

  private flushEntry(
    entry: { identity: FrontendIdentity; socket: T | null; pending: BridgeMessage[] },
    send: (socket: T, message: BridgeMessage) => boolean,
  ) {
    while (entry.socket && entry.pending.length > 0) {
      const next = entry.pending[0];
      if (!send(entry.socket, next)) return;
      entry.pending.shift();
    }
  }

  private enqueuePending(
    entry: { identity: FrontendIdentity; socket: T | null; pending: BridgeMessage[] },
    message: BridgeMessage,
  ) {
    entry.pending.push(message);
    if (entry.pending.length > this.maxPendingMessages) {
      entry.pending.splice(0, entry.pending.length - this.maxPendingMessages);
    }
  }
}

export function formatPeerMessageForCodex(message: BridgeMessage, senderName: string) {
  return `From ${senderName}:\n${message.content}`;
}
