import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function isolatedState() {
  return env.TENANTS.getByName(`admin-session-${crypto.randomUUID()}`);
}

async function changePasswordResult(
  state: ReturnType<typeof isolatedState>,
  token: string,
  currentPassword: string,
  newPassword: string,
): Promise<string> {
  // Catch inside the object isolate. Miniflare otherwise reports an expected
  // rejected RPC as an additional process-level unhandled rejection.
  return runInDurableObject(state, async (instance) => {
    try {
      await instance.changePassword(token, currentPassword, newPassword);
      return "OK";
    } catch (cause) {
      return cause instanceof Error ? cause.message : "UNKNOWN_ERROR";
    }
  });
}

describe("administrator password session boundary", () => {
  it("never permits first-run password replacement without a live admin session", async () => {
    const state = isolatedState();

    await expect(changePasswordResult(state, "", "admin888", "safe-first-password"))
      .resolves.toBe("ADMIN_SESSION_REQUIRED");
    await expect(changePasswordResult(state, "not-a-session", "admin888", "safe-first-password"))
      .resolves.toBe("ADMIN_SESSION_REQUIRED");

    const unchanged = await state.login("admin888", "192.0.2.10");
    expect(unchanged).toMatchObject({ ok: true, mustChangePassword: true });
  });

  it("requires the current password after login and keeps the session usable after a rejected change", async () => {
    const state = isolatedState();
    const login = await state.login("admin888", "192.0.2.11");
    if (!login.ok) throw new Error("test login failed");

    await expect(changePasswordResult(state, login.token, "wrong-current", "safe-first-password"))
      .resolves.toBe("INVALID_ADMIN_PASSWORD");
    await expect(state.session(login.token)).resolves.toEqual({ authenticated: true, mustChangePassword: true });
  });

  it("allows an authenticated first change and invalidates every old session", async () => {
    const state = isolatedState();
    const first = await state.login("admin888", "192.0.2.12");
    const second = await state.login("admin888", "192.0.2.13");
    if (!first.ok || !second.ok) throw new Error("test login failed");

    await expect(changePasswordResult(state, first.token, "admin888", "safe-first-password")).resolves.toBe("OK");
    await expect(state.session(first.token)).resolves.toEqual({ authenticated: false, mustChangePassword: false });
    await expect(state.session(second.token)).resolves.toEqual({ authenticated: false, mustChangePassword: false });
    await expect(changePasswordResult(state, second.token, "safe-first-password", "another-safe-password"))
      .resolves.toBe("ADMIN_SESSION_REQUIRED");

    await expect(state.login("admin888", "192.0.2.14")).resolves.toMatchObject({ ok: false, error: "INVALID_ADMIN_PASSWORD" });
    await expect(state.login("safe-first-password", "192.0.2.14")).resolves.toMatchObject({ ok: true, mustChangePassword: false });
  });

  it("keeps the bootstrap password at admin888 and accepts exactly eight-character replacements", async () => {
    const state = isolatedState();
    const login = await state.login("admin888", "192.0.2.15");
    if (!login.ok) throw new Error("test login failed");

    await expect(changePasswordResult(state, login.token, "admin888", "1234567"))
      .resolves.toBe("PASSWORD_TOO_SHORT");
    await expect(state.session(login.token)).resolves.toEqual({ authenticated: true, mustChangePassword: true });
    await expect(changePasswordResult(state, login.token, "admin888", "12345678")).resolves.toBe("OK");
    await expect(state.login("12345678", "192.0.2.16")).resolves.toMatchObject({ ok: true, mustChangePassword: false });
  });
});
