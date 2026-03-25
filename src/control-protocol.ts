import type { BridgeMessage, FrontendIdentity } from "./types";

export interface DaemonStatus {
  bridgeReady: boolean;
  tuiConnected: boolean;
  threadId: string | null;
  queuedMessageCount: number;
  proxyUrl: string;
  appServerUrl: string;
  pid: number;
  connectedFrontends: FrontendIdentity[];
}

export type ControlClientMessage =
  | { type: "frontend_connect"; frontend: FrontendIdentity }
  | { type: "frontend_disconnect"; frontendId?: string }
  | { type: "frontend_to_codex"; requestId: string; message: BridgeMessage }
  | { type: "claude_connect" }
  | { type: "claude_disconnect" }
  | { type: "claude_to_codex"; requestId: string; message: BridgeMessage }
  | { type: "status" };

export type ControlServerMessage =
  | { type: "bridge_message"; message: BridgeMessage }
  | { type: "frontend_to_codex_result"; requestId: string; success: boolean; error?: string }
  | { type: "codex_to_claude"; message: BridgeMessage }
  | { type: "claude_to_codex_result"; requestId: string; success: boolean; error?: string }
  | { type: "status"; status: DaemonStatus };
