/**
 * Sanitized production/client incidents that previously caused dropped turns,
 * context loss, duplicate actions, or account-risky replay. These strings are
 * regression labels and contain no server address, account, token, or API key.
 */
export const HISTORICAL_SERVER_INCIDENTS = {
  silentLongTurn: {
    id: "HIST-LONG-001",
    symptom: "stream disconnected before completion after a silent long model turn",
    invariant: "idle read slices must not terminate the global turn and the client stream must keep receiving progress heartbeats",
  },
  preSubmitFailover: {
    id: "HIST-ACCOUNT-002",
    symptom: "a transport handshake failed before the upstream invocation was submitted",
    invariant: "one bounded reconnect or ordered account failover is allowed only before submission and visible output",
  },
  postSubmitReplay: {
    id: "HIST-ACCOUNT-003",
    symptom: "ws read before completion: i/o timeout after the request had reached the upstream",
    invariant: "a submitted invocation must never be replayed on the same or a different account",
  },
  downstreamCancellation: {
    id: "HIST-CANCEL-004",
    symptom: "the client disconnected while an upstream request and account gate were active",
    invariant: "cancellation releases leases and cannot be interpreted as an account failure or failover signal",
  },
  repeatedSuccessfulAction: {
    id: "HIST-TOOL-005",
    symptom: "a model kept reissuing an already successful tool action",
    invariant: "one identical verification is allowed; a third identical completed action is blocked before execution",
  },
  repeatedFailedAction: {
    id: "HIST-TOOL-006",
    symptom: "repeated tool failure detected; the same action was retried without inspecting its result",
    invariant: "two normalized equivalent failures block the unchanged action while a materially changed action remains legal",
  },
  fullHistoryContinuation: {
    id: "HIST-CONTEXT-007",
    symptom: "previous_response_id continuation replayed the entire client history and duplicated old tool calls/results",
    invariant: "only the pending current tool result and genuinely new input are forwarded to the persisted upstream conversation",
  },
  orphanToolResult: {
    id: "HIST-TOOL-008",
    symptom: "unexpected tool result: call id was unknown, already consumed, or lacked previous_response_id",
    invariant: "orphan and replayed tool results are rejected before account selection",
  },
  truncatedResponsesStream: {
    id: "HIST-STREAM-009",
    symptom: "the Responses stream ended without a typed terminal event or [DONE]",
    invariant: "every failed Responses stream emits response.failed, error, and [DONE] exactly once",
  },
  accountQueueAndIsolation: {
    id: "HIST-ACCOUNT-010",
    symptom: "random account selection and polling races reordered requests or touched unused accounts",
    invariant: "per-account gates are FIFO and accounts outside the selected session remain independent and healthy",
  },
  autoToolRouting: {
    id: "HIST-TOOL-011",
    symptom: "an automatic local-file request returned prose claiming that the workspace was inaccessible instead of calling the declared read tool",
    invariant: "tool_choice auto must run one bounded routing decision and continue any selected call from the router conversation coordinates",
  },
} as const;
