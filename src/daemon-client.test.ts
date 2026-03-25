import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonClient } from "./daemon-client";
import type { FrontendIdentity } from "./types";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static connectionPlan: Array<"open" | "error" | "close"> = [];
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly url: string;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);

    const outcome = FakeWebSocket.connectionPlan.shift() ?? "open";
    queueMicrotask(() => {
      if (outcome === "open") {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
        return;
      }

      this.readyState = FakeWebSocket.CLOSED;
      if (outcome === "error") {
        this.onerror?.();
      }
      this.onclose?.();
    });
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.emitClose();
  }

  emitClose() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const FRONTEND: FrontendIdentity = {
  id: "claude_claude",
  source: "claude",
  name: "Claude",
};

const OriginalWebSocket = globalThis.WebSocket;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("DaemonClient reconnect behavior", () => {
  beforeEach(() => {
    FakeWebSocket.connectionPlan = [];
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  test("reattaches the frontend automatically after a control-socket reconnect", async () => {
    FakeWebSocket.connectionPlan = ["open", "open"];

    let beforeReconnectCalls = 0;
    const client = new DaemonClient("ws://127.0.0.1:4502/ws", FRONTEND, {
      reconnectBaseDelayMs: 1,
      maxReconnectAttempts: 2,
      beforeReconnect: async () => {
        beforeReconnectCalls++;
      },
    });

    const events: string[] = [];
    client.on("disconnect", () => events.push("disconnect"));
    client.on("reconnected", () => events.push("reconnected"));

    await client.connect();
    client.attachFrontend();

    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    expect(firstSocket.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "frontend_connect", frontend: FRONTEND },
    ]);

    firstSocket.emitClose();
    await sleep(20);

    expect(beforeReconnectCalls).toBeGreaterThanOrEqual(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "frontend_connect", frontend: FRONTEND },
    ]);
    expect(events).toEqual(["disconnect", "reconnected"]);

    await client.disconnect();
  });

  test("manual disconnect disables the reconnect loop", async () => {
    FakeWebSocket.connectionPlan = ["open", "open"];

    const client = new DaemonClient("ws://127.0.0.1:4502/ws", FRONTEND, {
      reconnectBaseDelayMs: 1,
      maxReconnectAttempts: 2,
    });

    await client.connect();
    client.attachFrontend();

    const firstSocket = FakeWebSocket.instances[0];
    await client.disconnect();
    await sleep(20);

    expect(firstSocket.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "frontend_connect", frontend: FRONTEND },
      { type: "frontend_disconnect", frontendId: FRONTEND.id },
    ]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("retries an initial connection failure and attaches once the daemon becomes reachable", async () => {
    FakeWebSocket.connectionPlan = ["error", "open"];

    let beforeReconnectCalls = 0;
    const client = new DaemonClient("ws://127.0.0.1:4502/ws", FRONTEND, {
      reconnectBaseDelayMs: 1,
      maxReconnectAttempts: 2,
      beforeReconnect: async () => {
        beforeReconnectCalls++;
      },
    });

    client.attachFrontend();
    await expect(client.connect()).rejects.toThrow("Failed to connect to AgentBridge daemon");
    await sleep(20);

    expect(beforeReconnectCalls).toBeGreaterThanOrEqual(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "frontend_connect", frontend: FRONTEND },
    ]);

    await client.disconnect();
  });

  test("can start the reconnect loop even when startup failed before the first socket connect attempt", async () => {
    FakeWebSocket.connectionPlan = ["error", "open"];

    let beforeReconnectCalls = 0;
    const client = new DaemonClient("ws://127.0.0.1:4502/ws", FRONTEND, {
      reconnectBaseDelayMs: 1,
      maxReconnectAttempts: 2,
      beforeReconnect: async () => {
        beforeReconnectCalls++;
      },
    });

    client.attachFrontend();
    client.ensureReconnectLoop();
    await sleep(20);

    expect(beforeReconnectCalls).toBeGreaterThanOrEqual(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "frontend_connect", frontend: FRONTEND },
    ]);

    await client.disconnect();
  });

  test("keeps retrying by default until the daemon becomes reachable", async () => {
    FakeWebSocket.connectionPlan = [
      "error",
      "error",
      "error",
      "error",
      "error",
      "error",
      "error",
      "error",
      "error",
      "error",
      "error",
      "error",
      "open",
    ];

    let beforeReconnectCalls = 0;
    const client = new DaemonClient("ws://127.0.0.1:4502/ws", FRONTEND, {
      reconnectBaseDelayMs: 0,
      beforeReconnect: async () => {
        beforeReconnectCalls++;
      },
    });

    client.attachFrontend();
    client.ensureReconnectLoop();
    await sleep(50);

    expect(beforeReconnectCalls).toBeGreaterThanOrEqual(12);
    expect(FakeWebSocket.instances).toHaveLength(13);
    expect(FakeWebSocket.instances.at(-1)?.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "frontend_connect", frontend: FRONTEND },
    ]);

    await client.disconnect();
  });
});
