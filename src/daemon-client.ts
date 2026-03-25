import { EventEmitter } from "node:events";
import type { BridgeMessage, FrontendIdentity } from "./types";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "./control-protocol";

interface DaemonClientEvents {
  bridgeMessage: [BridgeMessage];
  disconnect: [];
  reconnected: [];
  status: [DaemonStatus];
}

interface DaemonClientOptions {
  beforeReconnect?: () => Promise<void>;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
}

export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private ws: WebSocket | null = null;
  private nextRequestId = 1;
  private connectPromise: Promise<void> | null = null;
  private pendingReplies = new Map<
    string,
    {
      resolve: (value: { success: boolean; error?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private shouldAttachFrontend = false;
  private explicitlyDisconnected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;

  constructor(
    private readonly url: string,
    private readonly frontend: FrontendIdentity,
    private readonly options: DaemonClientOptions = {},
  ) {
    super();
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.explicitlyDisconnected = false;
    const connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let settled = false;

      ws.onopen = () => {
        settled = true;
        this.ws = ws;
        this.attachSocketHandlers(ws);
        this.reconnectAttempts = 0;
        if (this.shouldAttachFrontend) {
          this.send({ type: "frontend_connect", frontend: this.frontend });
        }
        if (this.reconnecting) {
          this.reconnecting = false;
          this.emit("reconnected");
        }
        resolve();
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        if (!this.explicitlyDisconnected) {
          this.scheduleReconnect();
        }
        reject(new Error(`Failed to connect to AgentBridge daemon at ${this.url}`));
      };

      ws.onclose = () => {
        if (settled) return;
        settled = true;
        if (!this.explicitlyDisconnected) {
          this.scheduleReconnect();
        }
        reject(new Error(`AgentBridge daemon closed the connection during startup (${this.url})`));
      };
    });

    this.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = null;
      }
    }
  }

  attachFrontend() {
    this.shouldAttachFrontend = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "frontend_connect", frontend: this.frontend });
    }
  }

  async disconnect() {
    this.explicitlyDisconnected = true;
    this.clearReconnectTimer();
    if (!this.ws) return;

    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: "frontend_disconnect", frontendId: this.frontend.id });
      }
    } catch {}

    try {
      this.ws.close();
    } catch {}

    this.ws = null;
    this.rejectPendingReplies("Daemon connection closed");
  }

  async sendReply(message: BridgeMessage): Promise<{ success: boolean; error?: string }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: "AgentBridge daemon is not connected." };
    }

    const requestId = `reply_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        resolve({ success: false, error: "Timed out waiting for AgentBridge daemon reply." });
      }, 15000);

      this.pendingReplies.set(requestId, { resolve, timer });
      this.send({
        type: "frontend_to_codex",
        requestId,
        message,
      });
    });
  }

  private attachSocketHandlers(ws: WebSocket) {
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();

      let message: ControlServerMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      switch (message.type) {
        case "bridge_message":
        case "codex_to_claude":
          this.emit("bridgeMessage", message.message);
          return;
        case "frontend_to_codex_result":
        case "claude_to_codex_result": {
          const pending = this.pendingReplies.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingReplies.delete(message.requestId);
          pending.resolve({ success: message.success, error: message.error });
          return;
        }
        case "status":
          this.emit("status", message.status);
          return;
      }
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.rejectPendingReplies("AgentBridge daemon disconnected.");
      this.emit("disconnect");
      if (!this.explicitlyDisconnected) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // The close handler is the single place that tears down pending state.
    };
  }

  private scheduleReconnect() {
    if (this.explicitlyDisconnected || this.reconnectTimer) return;

    const maxReconnectAttempts = this.options.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempts >= maxReconnectAttempts) {
      return;
    }

    const reconnectBaseDelayMs = this.options.reconnectBaseDelayMs ?? 1000;
    const delay = Math.min(reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.reconnecting = true;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.explicitlyDisconnected) return;

      try {
        await this.options.beforeReconnect?.();
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private rejectPendingReplies(error: string) {
    for (const [requestId, pending] of this.pendingReplies.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, error });
      this.pendingReplies.delete(requestId);
    }
  }

  private send(message: ControlClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("AgentBridge daemon socket is not open.");
    }

    this.ws.send(JSON.stringify(message));
  }
}
