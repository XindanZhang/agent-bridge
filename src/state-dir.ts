import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export class StateDirResolver {
  private readonly stateDir: string;

  constructor(override?: string) {
    const explicit = override ?? process.env.AGENTBRIDGE_STATE_DIR;
    if (explicit) {
      this.stateDir = explicit;
      return;
    }

    if (platform() === "darwin") {
      this.stateDir = join(homedir(), "Library", "Application Support", "AgentBridge");
      return;
    }

    const xdgStateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    this.stateDir = join(xdgStateHome, "agentbridge");
  }

  ensure() {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }

  get dir() {
    return this.stateDir;
  }

  get pidFile() {
    return join(this.stateDir, "daemon.pid");
  }

  get lockFile() {
    return join(this.stateDir, "daemon.lock");
  }

  get statusFile() {
    return join(this.stateDir, "status.json");
  }

  get logFile() {
    return join(this.stateDir, "agentbridge.log");
  }

  get killedFile() {
    return join(this.stateDir, "killed");
  }
}
