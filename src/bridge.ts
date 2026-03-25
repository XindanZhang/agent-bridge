#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ClaudeAdapter } from "./claude-adapter";
import { DaemonClient } from "./daemon-client";
import { DaemonLaunchCoordinator } from "./daemon-launch";
import { buildFrontendIdentity } from "./frontend-identity";
import { StateDirResolver } from "./state-dir";
import type { BridgeMessage, FrontendSource } from "./types";

const stateDir = new StateDirResolver();
stateDir.ensure();

const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const PID_FILE = process.env.AGENTBRIDGE_PID_FILE ?? stateDir.pidFile;
const LOCK_FILE = process.env.AGENTBRIDGE_LOCK_FILE ?? stateDir.lockFile;
const LOG_FILE = process.env.AGENTBRIDGE_LOG_FILE ?? stateDir.logFile;
const DAEMON_PATH = fileURLToPath(new URL("./daemon.ts", import.meta.url));
const FRONTEND_SOURCE: FrontendSource =
  (process.env.AGENTBRIDGE_FRONTEND_TYPE as FrontendSource) === "gemini" ? "gemini" : "claude";
const FRONTEND_NAME = process.env.AGENTBRIDGE_FRONTEND_NAME
  ?? (FRONTEND_SOURCE === "gemini" ? "Gemini" : "Claude");
const FRONTEND_IDENTITY = buildFrontendIdentity(FRONTEND_SOURCE, FRONTEND_NAME);
const daemonLifecycle = new DaemonLaunchCoordinator({
  controlPort: CONTROL_PORT,
  daemonPath: DAEMON_PATH,
  stateDir: stateDir.dir,
  pidFile: PID_FILE,
  lockFile: LOCK_FILE,
  log,
});

const frontendAdapter = new ClaudeAdapter();
const daemonClient = new DaemonClient(daemonLifecycle.controlWsUrl, FRONTEND_IDENTITY, {
  beforeReconnect: ensureDaemonRunning,
});

let shuttingDown = false;

frontendAdapter.setReplySender(async (msg: BridgeMessage) => {
  if (msg.source !== FRONTEND_SOURCE) {
    return { success: false, error: "Invalid message source" };
  }

  return daemonClient.sendReply(msg);
});

daemonClient.on("bridgeMessage", (message) => {
  log(`Forwarding daemon → ${FRONTEND_NAME} (${message.content.length} chars)`);
  void frontendAdapter.pushNotification(message);
});

daemonClient.on("status", (status) => {
  log(
    `Daemon status: ready=${status.bridgeReady} tui=${status.tuiConnected} thread=${status.threadId ?? "none"} queued=${status.queuedMessageCount}`,
  );
});

daemonClient.on("disconnect", () => {
  if (shuttingDown) return;

  log("Daemon control connection closed");
  void frontendAdapter.pushNotification(systemMessage(
    "system_daemon_disconnected",
    `⚠️ AgentBridge daemon control connection lost. ${FRONTEND_NAME} will keep retrying in the background until the bridge becomes reachable again.`,
  ));
});

daemonClient.on("reconnected", () => {
  if (shuttingDown) return;

  log("Daemon control connection restored");
  void frontendAdapter.pushNotification(systemMessage(
    "system_daemon_reconnected",
    `✅ AgentBridge daemon control connection restored. ${FRONTEND_NAME} is attached again.`,
  ));
});

frontendAdapter.on("ready", async () => {
  log(`MCP server ready for ${FRONTEND_NAME} (delivery mode: ${frontendAdapter.getDeliveryMode()}) — ensuring AgentBridge daemon...`);

  try {
    daemonClient.attachFrontend();
    await ensureDaemonRunning();
    await daemonClient.connect();
  } catch (err: any) {
    log(`Failed to connect to daemon: ${err.message}`);
    await frontendAdapter.pushNotification(
      systemMessage(
        "system_daemon_connect_failed",
        `❌ AgentBridge daemon failed to start or is unreachable: ${err.message}. ${FRONTEND_NAME} will continue retrying automatically.`,
      ),
    );
    daemonClient.ensureReconnectLoop();
  }
});

function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${Date.now()}`,
    source: "system",
    content,
    timestamp: Date.now(),
  };
}

async function ensureDaemonRunning() {
  await daemonLifecycle.ensureRunning();
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down ${FRONTEND_NAME} frontend (${reason})...`);
  const hardExit = setTimeout(() => {
    log("Shutdown timed out waiting for daemon disconnect; forcing exit");
    process.exit(0);
  }, 3000);

  void daemonClient.disconnect().finally(() => {
    clearTimeout(hardExit);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("exit", () => {
  if (shuttingDown) return;
  void daemonClient.disconnect();
});
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [AgentBridgeFrontend] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}

log(`Starting AgentBridge frontend ${FRONTEND_NAME} (daemon ws ${daemonLifecycle.controlWsUrl})`);

(async () => {
  try {
    await frontendAdapter.start();
  } catch (err: any) {
    log(`Fatal: failed to start MCP server: ${err.message}`);
  }
})();
