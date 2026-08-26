import type { ToolLedger } from "./tool-ledger";

/**
 * Operations for which an assistant must have matching, successful tool
 * evidence before it can make a strong completion claim.
 */
export type CompletionAction =
  | "deploy"
  | "fix"
  | "install"
  | "verify"
  | "upload"
  | "delete"
  | "create"
  | "configure"
  | "start"
  | "complete";

export type CompletionEvidenceStatus = "success" | "failure" | "unknown" | "pending";

/**
 * A deliberately small structural type. ToolLedger is assignable to this
 * interface, while tests and future protocol adapters can provide an already
 * reduced ledger without coupling to a particular request format.
 */
export interface CompletionEvidenceRecord {
  name?: string;
  arguments?: unknown;
  normalizedArguments?: string;
  result?: unknown;
  failed?: boolean;
  status?: Exclude<CompletionEvidenceStatus, "pending">;
}

export interface CompletionEvidenceLedger {
  completed: readonly CompletionEvidenceRecord[];
  pending?: readonly CompletionEvidenceRecord[];
}

export interface CompletionActionEvidence {
  latest: CompletionEvidenceStatus;
  successes: number;
  failures: number;
  unknown: number;
  pending: number;
}

/**
 * Sanitized evidence only. It intentionally contains no tool name, arguments,
 * output, call ID, error text, path, token, URL, or other potentially sensitive
 * material and is therefore safe to retain in request-local diagnostics.
 */
export interface CompletionEvidenceSummary {
  actions: Partial<Record<Exclude<CompletionAction, "complete">, CompletionActionEvidence>>;
  successfulTools: number;
  failedTools: number;
  unknownTools: number;
  pendingTools: number;
  classifiedSuccessfulTools: number;
  classifiedFailedTools: number;
  unclassifiedFailedTools: number;
  unclassifiedUnknownTools: number;
}

export type CompletionEvidenceReason =
  | "no_completion_claim"
  | "supported"
  | "pending_evidence"
  | "failed_evidence"
  | "unknown_evidence"
  | "missing_evidence";

export interface CompletionEvidenceDecision {
  allowed: boolean;
  /**
   * `terminate` is used when a matching call is pending or failed. `downgrade`
   * replaces an unsupported success assertion with an honest, non-success
   * terminal response instead of asking the client to retry the same tool.
   */
  disposition: "allow" | "downgrade" | "terminate";
  reason: CompletionEvidenceReason;
  claimedActions: CompletionAction[];
  unsupportedActions: CompletionAction[];
  /** Fixed text only; it never interpolates raw evidence. */
  replacementText?: string;
}

type OperationalAction = Exclude<CompletionAction, "complete">;

const operationalActions: readonly OperationalAction[] = [
  "deploy",
  "fix",
  "install",
  "verify",
  "upload",
  "delete",
  "create",
  "configure",
  "start",
];

const failureSignal = /(?:exit\s*(?:code|status)?\s*[:=]?\s*[1-9]\d*|\berror\b|\bfailed\b|\bfailure\b|exception|traceback|timed?\s*out|timeout|permission denied|not found|refused|cancel(?:led|ed)|operation was canceled|\u9519\u8bef|\u5931\u8d25|\u8d85\u65f6|\u62d2\u7edd|\u65e0\u6743\u9650|\u627e\u4e0d\u5230|\u4e0d\u5b58\u5728|\u5df2\u53d6\u6d88)/iu;

/**
 * Categories are inferred from the operation requested of the tool, never from
 * untrusted tool output. This prevents a read-only tool result containing text
 * such as "deployed successfully" from manufacturing deployment evidence.
 */
const operationPatterns: Readonly<Record<OperationalAction, readonly RegExp[]>> = {
  deploy: [
    /(?:^|[_:\s-])(?:deploy|deployment|release)(?:$|[_:\s-])/iu,
    /\bwrangler\s+deploy\b/iu,
    /\bnpm\s+(?:run\s+)?deploy\b/iu,
    /\bkubectl\s+(?:apply|rollout)\b/iu,
    /\bdocker(?:\s+compose|\s+stack)?\s+(?:up|deploy)\b/iu,
  ],
  fix: [
    /(?:^|[_:\s-])(?:fix|repair|patch)(?:$|[_:\s-])/iu,
    /\bapply[_-]?patch\b/iu,
    /(?:\u4fee\u590d|\u8865\u4e01)/u,
  ],
  install: [
    /(?:^|[_:\s-])(?:install|installer|setup)(?:$|[_:\s-])/iu,
    /\b(?:apt(?:-get)?|dnf|yum|pip\d*|npm|pnpm|yarn|winget|choco)\s+install\b/iu,
    /(?:\u5b89\u88c5)/u,
  ],
  verify: [
    /(?:^|[_:\s-])(?:verify|validate|tests?|checks?|health|doctor|audit|inspect|read|view|stat)(?:$|[_:\s-])/iu,
    /\b(?:go|npm|pnpm|yarn|cargo|pytest|vitest)\s+(?:run\s+)?test\b/iu,
    /\bcurl\b[^\r\n]{0,160}\b(?:health|status|ready)\b/iu,
    /(?:\u9a8c\u8bc1|\u6d4b\u8bd5|\u68c0\u67e5|\u5ba1\u8ba1)/u,
  ],
  upload: [
    /(?:^|[_:\s-])(?:upload|publish|push|sync)(?:$|[_:\s-])/iu,
    /\bgit\s+push\b/iu,
    /\b(?:scp|rsync|rclone)\b/iu,
    /\baws\s+s3\s+(?:cp|sync)\b/iu,
    /(?:\u4e0a\u4f20|\u53d1\u5e03|\u63a8\u9001|\u540c\u6b65)/u,
  ],
  delete: [
    /(?:^|[_:\s-])(?:delete|remove|cleanup|clean|purge)(?:$|[_:\s-])/iu,
    /(?:^|[;&|\s])rm\s+(?:-[^\s]+\s+)*(?:--\s+)?[^\s]/iu,
    /\bRemove-Item\b/iu,
    /(?:\u5220\u9664|\u79fb\u9664|\u6e05\u7406)/u,
  ],
  create: [
    /(?:^|[_:\s-])(?:create|provision|scaffold|mkdir)(?:$|[_:\s-])/iu,
    /\b(?:mkdir|New-Item)\b/iu,
    /(?:\u521b\u5efa|\u65b0\u5efa)/u,
  ],
  configure: [
    /(?:^|[_:\s-])(?:configure|config|edit|write|update|modify|save|set)(?:$|[_:\s-])/iu,
    /\b(?:Set-Content|Add-Content)\b/iu,
    /(?:\u914d\u7f6e|\u4fee\u6539|\u66f4\u65b0|\u4fdd\u5b58)/u,
  ],
  start: [
    /(?:^|[_:\s-])(?:start|restart|launch|run_service)(?:$|[_:\s-])/iu,
    /\bsystemctl\s+(?:start|restart|reload)\b/iu,
    /\bStart-Service\b/iu,
    /(?:\u542f\u52a8|\u91cd\u542f|\u91cd\u8f7d)/u,
  ],
};

const claimPatterns: Readonly<Record<CompletionAction, readonly RegExp[]>> = {
  deploy: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u5b8c\u6210)?\s*(?:\u90e8\u7f72|\u4e0a\u7ebf)/giu,
    /(?:\u90e8\u7f72|\u4e0a\u7ebf)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?deployed\b/giu,
    /\bdeployment\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
    /\b(?:is|went)\s+live\b/giu,
  ],
  fix: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u5f7b\u5e95)?\s*(?:\u4fee\u590d|\u89e3\u51b3)/giu,
    /(?:\u4fee\u590d|\u6574\u6539)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:fixed|repaired|resolved)\b/giu,
    /\b(?:fix|repair|remediation)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  install: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*\u5b89\u88c5/giu,
    /\u5b89\u88c5(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?installed\b/giu,
    /\binstallation\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  verify: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u9a8c\u8bc1|\u6d4b\u8bd5|\u68c0\u67e5)/giu,
    /(?:\u9a8c\u8bc1|\u6d4b\u8bd5|\u68c0\u67e5)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u901a\u8fc7|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?verified\b/giu,
    /\b(?:verification|validation|tests?|checks?)\s+(?:(?:is|are|was|were|has\s+been|have\s+been)\s+)?(?:complete|completed|successful|passed)\b/giu,
  ],
  upload: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u4e0a\u4f20|\u53d1\u5e03|\u63a8\u9001|\u540c\u6b65)/giu,
    /(?:\u4e0a\u4f20|\u53d1\u5e03|\u63a8\u9001|\u540c\u6b65)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:uploaded|published|pushed|synced)\b/giu,
    /\b(?:upload|publication|push|sync)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  delete: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u5220\u9664|\u79fb\u9664|\u6e05\u7406)/giu,
    /(?:\u5220\u9664|\u79fb\u9664|\u6e05\u7406)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:deleted|removed|cleaned|purged)\b/giu,
    /\b(?:deletion|removal|cleanup)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  create: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u521b\u5efa|\u65b0\u5efa)/giu,
    /(?:\u521b\u5efa|\u65b0\u5efa)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?created\b/giu,
    /\bcreation\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  configure: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u914d\u7f6e|\u4fee\u6539|\u66f4\u65b0|\u5199\u5165|\u4fdd\u5b58)/giu,
    /(?:\u914d\u7f6e|\u4fee\u6539|\u66f4\u65b0|\u5199\u5165|\u4fdd\u5b58)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:configured|updated|modified|written|saved)\b/giu,
    /\b(?:configuration|update|modification)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  start: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u542f\u52a8|\u91cd\u542f|\u91cd\u8f7d)/giu,
    /(?:\u542f\u52a8|\u91cd\u542f|\u91cd\u8f7d)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:started|restarted|launched|reloaded)\b/giu,
    /\b(?:startup|restart|launch|reload)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  complete: [
    /(?:\u5168\u90e8|\u6240\u6709|\u6574\u4e2a|\u672c\u6b21)?\s*(?:\u4efb\u52a1|\u5de5\u4f5c|\u5904\u7406|\u64cd\u4f5c|\u6267\u884c|\u6574\u6539)\s*(?:\u5747|\u90fd)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5168\u90e8)?\s*(?:\u5b8c\u6210|\u5b8c\u6bd5)/giu,
    /(?:\u5168\u90e8|\u6240\u6709)\s*(?:\u90fd|\u5df2)?\s*(?:\u5b8c\u6210|\u5b8c\u6bd5)/giu,
    /\b(?:all\s+done|everything\s+(?:is\s+)?(?:done|complete)|task\s+(?:(?:is|was|has\s+been)\s+)?(?:done|complete|completed)|work\s+(?:(?:is|was|has\s+been)\s+)?(?:done|complete|completed)|completed\s+successfully)\b/giu,
  ],
};

function safeOperationText(record: CompletionEvidenceRecord): string {
  let argumentsText = "";
  if (typeof record.normalizedArguments === "string") {
    argumentsText = record.normalizedArguments;
  } else if (typeof record.arguments === "string") {
    argumentsText = record.arguments;
  } else if (record.arguments !== undefined) {
    try {
      argumentsText = JSON.stringify(record.arguments);
    } catch {
      argumentsText = "";
    }
  }
  // This value is used transiently for classification only and is never
  // returned, persisted, logged, or included in an error.
  return `${record.name ?? ""}\n${argumentsText}`.slice(0, 8_192);
}

function classifyOperation(record: CompletionEvidenceRecord): OperationalAction[] {
  const operation = safeOperationText(record);
  const actions: OperationalAction[] = [];
  for (const action of operationalActions) {
    if (operationPatterns[action].some((pattern) => pattern.test(operation))) actions.push(action);
  }
  return actions;
}

function compactResultText(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 4_096);
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result).slice(0, 4_096);
  } catch {
    return "";
  }
}

function evidenceStatus(record: CompletionEvidenceRecord): Exclude<CompletionEvidenceStatus, "pending"> {
  if (record.status) return record.status;
  if (record.failed === true) return "failure";
  if (record.failed === false) return "success";
  const result = compactResultText(record.result);
  if (!result.trim()) return "unknown";
  return failureSignal.test(result) ? "failure" : "success";
}

function emptyActionEvidence(status: CompletionEvidenceStatus): CompletionActionEvidence {
  return {
    latest: status,
    successes: 0,
    failures: 0,
    unknown: 0,
    pending: 0,
  };
}

function updateActionEvidence(
  actions: Partial<Record<OperationalAction, CompletionActionEvidence>>,
  action: OperationalAction,
  status: CompletionEvidenceStatus,
): void {
  const evidence = actions[action] ?? emptyActionEvidence(status);
  evidence.latest = status;
  if (status === "success") evidence.successes += 1;
  else if (status === "failure") evidence.failures += 1;
  else if (status === "unknown") evidence.unknown += 1;
  else evidence.pending += 1;
  actions[action] = evidence;
}

/** Reduces a full ledger to non-sensitive action/status counters. */
export function summarizeCompletionEvidence(
  ledger: CompletionEvidenceLedger | Pick<ToolLedger, "completed" | "pending">,
): CompletionEvidenceSummary {
  const summary: CompletionEvidenceSummary = {
    actions: {},
    successfulTools: 0,
    failedTools: 0,
    unknownTools: 0,
    pendingTools: ledger.pending?.length ?? 0,
    classifiedSuccessfulTools: 0,
    classifiedFailedTools: 0,
    unclassifiedFailedTools: 0,
    unclassifiedUnknownTools: 0,
  };

  for (const record of ledger.completed) {
    const status = evidenceStatus(record);
    if (status === "success") summary.successfulTools += 1;
    else if (status === "failure") summary.failedTools += 1;
    else summary.unknownTools += 1;

    const actions = classifyOperation(record);
    if (status === "success" && actions.length > 0) summary.classifiedSuccessfulTools += 1;
    if (status === "failure" && actions.length > 0) summary.classifiedFailedTools += 1;
    if (status === "failure" && actions.length === 0) summary.unclassifiedFailedTools += 1;
    if (status === "unknown" && actions.length === 0) summary.unclassifiedUnknownTools += 1;
    for (const action of actions) updateActionEvidence(summary.actions, action, status);
  }

  for (const record of ledger.pending ?? []) {
    for (const action of classifyOperation(record)) updateActionEvidence(summary.actions, action, "pending");
  }

  return summary;
}

function clauseBefore(text: string, index: number): string {
  const prefix = text.slice(Math.max(0, index - 80), index);
  const boundary = Math.max(prefix.lastIndexOf("，"), prefix.lastIndexOf(","), prefix.lastIndexOf("；"), prefix.lastIndexOf(";"));
  return prefix.slice(boundary + 1);
}

function isNonAssertiveContext(text: string, start: number, end: number): boolean {
  const before = clauseBefore(text, start);
  const after = text.slice(end, Math.min(text.length, end + 18));

  // Negation must be close to the matched phrase. This covers "not deployed",
  // "cannot confirm it was installed", and Chinese equivalents without making
  // an unrelated earlier negative clause suppress a real assertion.
  if (/(?:\u5c1a\u672a|\u8fd8\u672a|\u5e76\u672a|\u6ca1\u6709|\u6ca1\u80fd|\u672a\u80fd|\u65e0\u6cd5|\u4e0d\u80fd|\u4e0d\u66fe|\u5e76\u975e|\u4e0d\u53ef|\u4e0d\u786e\u5b9a|\u4e0d\u80fd\u786e\u8ba4)[^\uff0c,\u3002.!?\uff01\uff1f\uff1b;]{0,14}$/iu.test(before)) return true;
  if (/\b(?:not|never|cannot|can't|unable\s+to|failed\s+to|didn't|hasn't|haven't|wasn't|isn't|cannot\s+confirm|can't\s+confirm)\b[^,.!?;]{0,20}$/iu.test(before)) return true;

  // Plans, requirements, hypotheticals and preconditions are not claims that
  // an operation has actually happened.
  if (/(?:\u5982\u679c|\u82e5|\u5047\u5982|\u4e00\u65e6|\u53ea\u6709|\u9664\u975e|\u5f85|\u7b49\u5230|\u5c06|\u4f1a|\u51c6\u5907|\u8ba1\u5212|\u6253\u7b97|\u9700\u8981|\u5fc5\u987b|\u53ef\u4ee5|\u5e94\u5f53)[^\uff0c,\u3002.!?\uff01\uff1f\uff1b;]{0,30}$/u.test(before)) return true;
  if (/\b(?:if|when|once|unless|provided|assuming|will|would|could|should|can|may|might|plan(?:s|ned)?\s+to|intend(?:s|ed)?\s+to|need(?:s|ed)?\s+to|going\s+to|must)\b[^,.!?;]{0,35}$/iu.test(before)) return true;
  if (/^\s*(?:\u540e|\u4e4b\u540e|\u65f6|\u4ee5\u540e|\u518d|\u624d|after\b|before\b|once\b|if\b|when\b)/iu.test(after)) return true;

  // Quoted event/field names and "how it works" descriptions are prose about
  // a completion state, not assertions that the state was reached.
  if (/(?:\u540d\u4e3a|\u53eb\u4f5c|\u5b57\u6bb5|\u4e8b\u4ef6|\u5b57\u7b26\u4e32|\u672f\u8bed|\u8bf4\u660e|\u63cf\u8ff0|\u89e3\u91ca)[^\uff0c,\u3002.!?\uff01\uff1f\uff1b;]{0,16}[\u201c\u2018"']?$/u.test(before)
    && /^[\u201d\u2019"']?(?:\u4e8b\u4ef6|\u72b6\u6001|\u5b57\u6bb5|\u6d88\u606f|\u6d41\u7a0b|\u7684\u542b\u4e49|\u5982\u4f55|\u65f6)/u.test(after)) return true;
  if (/[\u201c\u2018"']\s*$/u.test(before)
    && /^[\u201d\u2019"'](?:\u4e8b\u4ef6|\u72b6\u6001|\u5b57\u6bb5|\u6d88\u606f|\u6d41\u7a0b|\u7684\u542b\u4e49)/u.test(after)) return true;
  if (/\b(?:called|named|phrase|term|event|field|message|explains?\s+how|describes?\s+how)\b[^,.!?;]{0,24}[\u201c\u2018"']?$/iu.test(before)
    && /^[\u201d\u2019"']?\s*(?:event|status|field|message|flow|means|works?)\b/iu.test(after)) return true;

  return false;
}

/** Finds strong operational completion claims, while excluding plans and denials. */
export function completionClaims(answer: string): CompletionAction[] {
  const claims = new Set<CompletionAction>();
  for (const action of [...operationalActions, "complete" as const]) {
    for (const pattern of claimPatterns[action]) {
      pattern.lastIndex = 0;
      for (const match of answer.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (!isNonAssertiveContext(answer, start, start + match[0].length)) claims.add(action);
      }
    }
  }
  // "completed successfully" frequently overlaps a specific phrase such as
  // "deployment completed successfully". In that sentence `complete` adds no
  // independent all-task assertion; evaluate the specific operation only.
  if (claims.size > 1) claims.delete("complete");
  return [...claims];
}

function replacementText(reason: CompletionEvidenceReason): string {
  if (reason === "pending_evidence") {
    return "当前仍有工具调用未返回，无法确认相关操作已完成。请先等待或检查最后一次工具结果。";
  }
  if (reason === "failed_evidence") {
    return "现有工具证据显示相关操作失败或未成功完成，因此不能声明已经完成。请检查最后一次失败结果后再决定下一步。";
  }
  if (reason === "unknown_evidence") {
    return "工具结果的状态无法核验，因此不能确认相关操作已经完成。";
  }
  return "没有与该完成声明对应的成功工具证据，因此暂时无法确认相关操作已经完成。";
}

function genericCompletionSupported(summary: CompletionEvidenceSummary): CompletionEvidenceReason {
  if (summary.pendingTools > 0) return "pending_evidence";
  if (summary.unclassifiedFailedTools > 0) return "failed_evidence";
  if (summary.unclassifiedUnknownTools > 0) return "unknown_evidence";
  if (summary.classifiedSuccessfulTools === 0) {
    if (summary.failedTools > 0) return "failed_evidence";
    if (summary.unknownTools > 0 || summary.successfulTools > 0) return "unknown_evidence";
    return "missing_evidence";
  }
  // A passive read/view/stat can support a precise verification claim, but it
  // cannot by itself prove that an entire multi-step task is complete.
  const successfulNonVerificationAction = Object.entries(summary.actions).some(([action, state]) => (
    action !== "verify" && state?.latest === "success"
  ));
  if (!successfulNonVerificationAction) return "unknown_evidence";
  for (const state of Object.values(summary.actions)) {
    if (state?.latest === "failure") return "failed_evidence";
    if (state?.latest === "unknown") return "unknown_evidence";
    if (state?.latest === "pending") return "pending_evidence";
  }
  return "supported";
}

/**
 * Evaluates the assistant's final prose against a sanitized evidence summary.
 * Every distinct asserted operation must be supported. One successful tool does
 * not authorize unrelated claims, and a later success only repairs failure for
 * the same classified operation.
 */
export function evaluateCompletionEvidence(
  answer: string,
  ledgerOrSummary: CompletionEvidenceLedger | Pick<ToolLedger, "completed" | "pending"> | CompletionEvidenceSummary,
): CompletionEvidenceDecision {
  const claims = completionClaims(answer);
  if (claims.length === 0) {
    return {
      allowed: true,
      disposition: "allow",
      reason: "no_completion_claim",
      claimedActions: [],
      unsupportedActions: [],
    };
  }

  const summary = "successfulTools" in ledgerOrSummary
    ? ledgerOrSummary
    : summarizeCompletionEvidence(ledgerOrSummary);
  const reasons = new Map<CompletionAction, CompletionEvidenceReason>();

  for (const claim of claims) {
    if (claim === "complete") {
      reasons.set(claim, genericCompletionSupported(summary));
      continue;
    }
    // An outstanding tool makes any strong terminal assertion unsafe, even if
    // its operation cannot be classified yet.
    if (summary.pendingTools > 0) {
      reasons.set(claim, "pending_evidence");
      continue;
    }
    const state = summary.actions[claim];
    if (!state) reasons.set(claim, "missing_evidence");
    else if (state.latest === "success") reasons.set(claim, "supported");
    else if (state.latest === "failure") reasons.set(claim, "failed_evidence");
    else if (state.latest === "unknown") reasons.set(claim, "unknown_evidence");
    else reasons.set(claim, "pending_evidence");
  }

  const unsupportedActions = claims.filter((claim) => reasons.get(claim) !== "supported");
  if (unsupportedActions.length === 0) {
    return {
      allowed: true,
      disposition: "allow",
      reason: "supported",
      claimedActions: claims,
      unsupportedActions: [],
    };
  }

  const unsupportedReasons = unsupportedActions.map((claim) => reasons.get(claim));
  const reason: CompletionEvidenceReason = unsupportedReasons.includes("pending_evidence")
    ? "pending_evidence"
    : unsupportedReasons.includes("failed_evidence")
      ? "failed_evidence"
      : unsupportedReasons.includes("unknown_evidence")
        ? "unknown_evidence"
        : "missing_evidence";
  return {
    allowed: false,
    disposition: reason === "pending_evidence" || reason === "failed_evidence" ? "terminate" : "downgrade",
    reason,
    claimedActions: claims,
    unsupportedActions,
    replacementText: replacementText(reason),
  };
}
