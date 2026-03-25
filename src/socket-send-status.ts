export type SocketSendOutcome = "sent" | "backpressure" | "dropped";

export function classifySocketSendStatus(status: number): SocketSendOutcome {
  if (status === 0) return "dropped";
  if (status === -1) return "backpressure";
  return "sent";
}
