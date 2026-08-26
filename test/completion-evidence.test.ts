import { describe, expect, it } from "vitest";
import {
  completionClaims,
  evaluateCompletionEvidence,
  summarizeCompletionEvidence,
  type CompletionEvidenceRecord,
} from "../src/completion-evidence";

function completed(
  name: string,
  status: "success" | "failure" | "unknown" = "success",
  argumentsValue: unknown = {},
  result?: unknown,
): CompletionEvidenceRecord {
  return { name, arguments: argumentsValue, status, result };
}

function ledger(
  completedRecords: CompletionEvidenceRecord[] = [],
  pendingRecords: CompletionEvidenceRecord[] = [],
) {
  return { completed: completedRecords, pending: pendingRecords };
}

describe("completion claim detection", () => {
  it("recognizes strong Chinese and English operational completion claims", () => {
    expect(completionClaims("已经部署并成功启动，测试已经通过，修复完成。")).toEqual(
      expect.arrayContaining(["deploy", "start", "verify", "fix"]),
    );
    expect(completionClaims("Installed, configured, uploaded and verified successfully.")).toEqual(
      expect.arrayContaining(["install", "configure", "upload", "verify"]),
    );
    expect(completionClaims("全部工作已经完成。")).toContain("complete");
  });

  it("does not turn denials, honest uncertainty, plans, or conditions into claims", () => {
    const samples = [
      "尚未部署，也没有安装。",
      "我无法确认已经修复。",
      "如果测试通过，将成功部署。",
      "部署完成后再验证。",
      "It was not deployed and has not been verified.",
      "If the checks pass, it will be deployed.",
      "We plan to install it after approval.",
      "I cannot confirm it was successfully uploaded.",
    ];
    for (const sample of samples) expect(completionClaims(sample), sample).toEqual([]);
  });

  it("does not block pure analysis, planning, or explanatory prose", () => {
    const samples = [
      "这是问题分析、整改方案和后续测试计划。",
      "分析已完成，以下内容只说明可能的修复步骤。",
      "This is an analysis and a proposed deployment plan, not an execution report.",
      "The following section explains the installation and verification process.",
    ];
    for (const sample of samples) {
      expect(evaluateCompletionEvidence(sample, ledger())).toMatchObject({
        allowed: true,
        reason: "no_completion_claim",
      });
    }
  });

  it("does not treat quoted completion state names as execution claims", () => {
    expect(completionClaims("\u201c\u90e8\u7f72\u5b8c\u6210\u201d\u4e8b\u4ef6\u662f\u56de\u8c03\u6d41\u7a0b\u7684\u4e00\u90e8\u5206\u3002")).toEqual([]);
    expect(completionClaims("The event named \"deployment completed\" means the rollout callback fired.")).toEqual([]);
  });
});

describe("action-correlated completion evidence", () => {
  it("treats an explicit successful client read as verification evidence only", () => {
    const readEvidence = ledger([{
      name: "read",
      arguments: JSON.stringify({ filePath: "C:/workspace/result.txt" }),
      result: "alpha-verified",
      failed: false,
    }]);
    expect(evaluateCompletionEvidence("Verified content: alpha-verified", readEvidence)).toMatchObject({
      allowed: true,
      reason: "supported",
      claimedActions: ["verify"],
    });
    expect(evaluateCompletionEvidence("Deployment completed successfully.", readEvidence)).toMatchObject({
      allowed: false,
      reason: "missing_evidence",
      unsupportedActions: ["deploy"],
    });
  });

  it("allows a completion assertion only when the same operation has successful evidence", () => {
    expect(evaluateCompletionEvidence("部署已完成。", ledger([
      completed("deploy_worker", "success"),
    ]))).toMatchObject({ allowed: true, reason: "supported" });

    expect(evaluateCompletionEvidence("Deployment completed successfully.", ledger([
      completed("verify_health", "success"),
    ]))).toMatchObject({
      allowed: false,
      reason: "missing_evidence",
      unsupportedActions: ["deploy"],
    });
  });

  it("does not let untrusted read-only output manufacture deployment evidence", () => {
    const decision = evaluateCompletionEvidence("The deployment is complete.", ledger([
      completed("read_file", "success", { path: "status.txt" }, "deployed successfully"),
    ]));
    expect(decision).toMatchObject({
      allowed: false,
      disposition: "downgrade",
      reason: "missing_evidence",
    });
  });

  it("uses terminal command intent for generic shell tools", () => {
    const decision = evaluateCompletionEvidence("已部署并验证通过。", ledger([
      completed("exec_command", "success", { cmd: "wrangler deploy" }, "ok"),
      completed("exec_command", "success", { cmd: "curl https://example.invalid/health" }, "status ok"),
    ]));
    expect(decision).toMatchObject({ allowed: true, reason: "supported" });
  });

  it("rejects completed calls whose result is failed", () => {
    const decision = evaluateCompletionEvidence("已经安装完成。", ledger([
      completed("install_dependencies", "failure", {}, "permission denied"),
    ]));
    expect(decision).toMatchObject({
      allowed: false,
      disposition: "terminate",
      reason: "failed_evidence",
      unsupportedActions: ["install"],
    });
    expect(decision.replacementText).not.toContain("permission denied");
  });

  it("lets a later success repair an earlier failure for the same operation", () => {
    const repaired = evaluateCompletionEvidence("修复完成。", ledger([
      completed("apply_patch", "failure"),
      completed("apply_patch", "success"),
    ]));
    expect(repaired).toMatchObject({ allowed: true, reason: "supported" });

    const regressed = evaluateCompletionEvidence("修复完成。", ledger([
      completed("apply_patch", "success"),
      completed("apply_patch", "failure"),
    ]));
    expect(regressed).toMatchObject({ allowed: false, reason: "failed_evidence" });
  });

  it("requires evidence for every action in a mixed claim", () => {
    const partial = evaluateCompletionEvidence("已经修复、部署并验证通过。", ledger([
      completed("apply_patch", "success"),
      completed("deploy_worker", "success"),
      completed("run_tests", "failure"),
    ]));
    expect(partial).toMatchObject({
      allowed: false,
      reason: "failed_evidence",
      unsupportedActions: ["verify"],
    });

    const complete = evaluateCompletionEvidence("已经修复、部署并验证通过。", ledger([
      completed("apply_patch", "success"),
      completed("deploy_worker", "success"),
      completed("run_tests", "success"),
    ]));
    expect(complete).toMatchObject({ allowed: true, reason: "supported" });
  });

  it("terminates strong claims while any tool result is still pending", () => {
    const decision = evaluateCompletionEvidence("已删除旧版本。", ledger(
      [completed("delete_release", "success")],
      [{ name: "verify_absence", arguments: {} }],
    ));
    expect(decision).toMatchObject({
      allowed: false,
      disposition: "terminate",
      reason: "pending_evidence",
    });
  });

  it("downgrades unknown results instead of treating them as success", () => {
    const decision = evaluateCompletionEvidence("配置已完成。", ledger([
      completed("configure_gateway", "unknown"),
    ]));
    expect(decision).toMatchObject({
      allowed: false,
      disposition: "downgrade",
      reason: "unknown_evidence",
    });
  });

  it("derives success and failure from legacy result-only records", () => {
    const successful = evaluateCompletionEvidence("Uploaded successfully.", ledger([
      { name: "upload_release", result: "exit code 0" },
    ]));
    expect(successful).toMatchObject({ allowed: true });

    const failed = evaluateCompletionEvidence("Uploaded successfully.", ledger([
      { name: "upload_release", result: "exit code 2: failed" },
    ]));
    expect(failed).toMatchObject({ allowed: false, reason: "failed_evidence" });
  });
});

describe("generic completion and privacy", () => {
  it("requires classified success and rejects unresolved failures for 'all done'", () => {
    expect(evaluateCompletionEvidence("全部工作已经完成。", ledger([
      completed("apply_patch", "success"),
      completed("run_tests", "success"),
    ]))).toMatchObject({ allowed: true, reason: "supported" });

    expect(evaluateCompletionEvidence("Everything is done.", ledger([
      completed("read_file", "success"),
    ]))).toMatchObject({ allowed: false, reason: "unknown_evidence" });

    expect(evaluateCompletionEvidence("Everything is done.", ledger([
      completed("apply_patch", "success"),
      completed("run_tests", "failure"),
    ]))).toMatchObject({ allowed: false, reason: "failed_evidence" });

    expect(evaluateCompletionEvidence("Everything is done.", ledger([
      completed("apply_patch", "success"),
      completed("opaque_tool", "failure"),
    ]))).toMatchObject({ allowed: false, reason: "failed_evidence" });
  });

  it("supports multiple independent successful operations", () => {
    const decision = evaluateCompletionEvidence(
      "Created, configured, installed, started, verified, uploaded, and deleted the temporary package successfully.",
      ledger([
        completed("create_project"),
        completed("configure_project"),
        completed("install_dependencies"),
        completed("start_service"),
        completed("verify_service"),
        completed("upload_release"),
        completed("delete_temp_package"),
      ]),
    );
    expect(decision).toMatchObject({ allowed: true, reason: "supported" });
  });

  it("returns only categorical counters and never raw sensitive tool material", () => {
    const secret = "m365_secret-value-that-must-not-leak";
    const summary = summarizeCompletionEvidence(ledger([
      completed("deploy_worker", "failure", { api_key: secret, command: "wrangler deploy" }, `error: ${secret}`),
    ], [
      { name: "verify_secret", arguments: { token: secret } },
    ]));
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("deploy_worker");
    expect(serialized).not.toContain("verify_secret");
    expect(serialized).not.toContain("api_key");
    expect(summary).toMatchObject({ failedTools: 1, pendingTools: 1, classifiedFailedTools: 1 });
  });

  it("never interpolates tool output into a rejection or diagnostic decision", () => {
    const secret = "PRIVATE_FAILURE_DETAIL";
    const decision = evaluateCompletionEvidence("Verified successfully.", ledger([
      completed("verify_service", "failure", {}, secret),
    ]));
    expect(JSON.stringify(decision)).not.toContain(secret);
    expect(decision.replacementText).toBeTruthy();
  });
});
