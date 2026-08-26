import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("API key lifecycle", () => {
  it("validates names and validity windows at the authoritative state boundary", async () => {
    const state = env.TENANTS.getByName(`api-key-validation-${crypto.randomUUID()}`);

    await runInDurableObject(state, async (instance) => {
      await expect(instance.createAPIKey("", 1)).rejects.toThrow("INVALID_API_KEY_NAME");
      await expect(instance.createAPIKey("x".repeat(101), 1)).rejects.toThrow("INVALID_API_KEY_NAME");
      await expect(instance.createAPIKey("invalid-negative", -1)).rejects.toThrow("INVALID_API_KEY_DAYS");
      await expect(instance.createAPIKey("invalid-fraction", 1.5)).rejects.toThrow("INVALID_API_KEY_DAYS");
      await expect(instance.createAPIKey("invalid-upper-bound", 3_651)).rejects.toThrow("INVALID_API_KEY_DAYS");

      const created = await instance.createAPIKey(" valid key ", 0);
      expect(created.record).toMatchObject({ name: "valid key", expires_at: 0, last_used_at: 0 });
      await expect(instance.updateAPIKeyExpiry(created.record.id, Number.NaN)).rejects.toThrow("INVALID_API_KEY_DAYS");
    });
  });

  it("records a real, bounded-write last-use timestamp without retaining the raw key", async () => {
    const state = env.TENANTS.getByName(`api-key-last-use-${crypto.randomUUID()}`);
    const created = await state.createAPIKey("last-used", 1);

    await expect(state.listAPIKeys()).resolves.toEqual([
      expect.objectContaining({ id: created.record.id, last_used_at: 0 }),
    ]);
    await expect(state.validAPIKey("m365_not-the-key")).resolves.toBe(false);
    await expect(state.validAPIKey(created.key)).resolves.toBe(true);

    const listed = await state.listAPIKeys();
    expect(listed[0].last_used_at).toBeGreaterThan(0);
    expect(JSON.stringify(listed)).not.toContain(created.key);
  });
});
