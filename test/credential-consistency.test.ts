import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { encryptJSON } from "../src/crypto";
import type { Env, OAuthTokenSet } from "../src/types";

function testToken(id: string, overrides: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 3_600_000,
    email: `${id}@example.test`,
    displayName: `Account ${id}`,
    oid: id,
    tid: "tenant-credential-consistency",
    ...overrides,
  };
}

function replaceSensitiveKV(instance: unknown, sensitiveKV: KVNamespace): void {
  const internal = instance as { env: Env };
  internal.env = { ...internal.env, SENSITIVE_KV: sensitiveKV };
}

function fakeKV(handlers: {
  get?: (key: string) => Promise<string | null>;
  put?: (key: string, value: string) => Promise<void>;
  delete?: (key: string) => Promise<void>;
} = {}): KVNamespace {
  return {
    get: vi.fn(handlers.get ?? (async () => null)),
    put: vi.fn(handlers.put ?? (async () => undefined)),
    delete: vi.fn(handlers.delete ?? (async () => undefined)),
  } as unknown as KVNamespace;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function unsignedJWT(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `e30.${payload}.signature`;
}

describe("strongly-consistent encrypted account credentials", () => {
  it("reads a newly authorized account from encrypted DO storage when KV stays invisible", async () => {
    const state = env.TENANTS.getByName(`credential-kv-invisible-${crypto.randomUUID()}`);
    const writes = new Map<string, string>();
    const unavailableKV = fakeKV({
      put: async (key, value) => { writes.set(key, value); },
      // Reproduce cross-PoP eventual consistency: PUT succeeds but every GET
      // at this location continues to return null.
      get: async () => null,
    });
    const token = testToken(`new-${crypto.randomUUID()}`);

    await runInDurableObject(state, async (instance, durableState) => {
      replaceSensitiveKV(instance, unavailableKV);
      await instance.upsertAccount(token);
      const stored = durableState.storage.sql.exec<{
        token_cipher: string;
        credential_kv_key: string;
        credential_revision: number;
      }>("SELECT token_cipher,credential_kv_key,credential_revision FROM accounts WHERE id=?", token.oid).one();

      expect(stored.token_cipher).not.toMatch(/^kv:/u);
      expect(stored.token_cipher).not.toContain(token.accessToken);
      expect(stored.token_cipher).not.toContain(token.refreshToken);
      expect(stored.token_cipher).not.toContain(token.email);
      expect(stored.credential_revision).toBe(1);
      expect(stored.credential_kv_key).not.toContain(token.oid);
      expect(stored.credential_kv_key).not.toContain(token.email);
      expect(writes.get(stored.credential_kv_key)).toBe(stored.token_cipher);

      await expect(instance.getAccountToken(token.oid)).resolves.toMatchObject(token);
      await expect(instance.getAccountToken(token.oid)).resolves.toMatchObject(token);
      expect(unavailableKV.get).not.toHaveBeenCalled();
      await expect(instance.accountAvailability(token.oid)).resolves.toMatchObject({ available: true, isolated: false });
    });
  });

  it("keeps the DO write successful when KV PUT fails and retries the encrypted mirror", async () => {
    const state = env.TENANTS.getByName(`credential-mirror-retry-${crypto.randomUUID()}`);
    const mirrored = new Map<string, string>();
    let failPut = true;
    const flakyKV = fakeKV({
      put: async (key, value) => {
        if (failPut) throw new Error("simulated kv outage");
        mirrored.set(key, value);
      },
    });
    const token = testToken(`mirror-${crypto.randomUUID()}`);

    await runInDurableObject(state, async (instance, durableState) => {
      replaceSensitiveKV(instance, flakyKV);
      await expect(instance.upsertAccount(token)).resolves.toMatchObject({ id: token.oid });
      await expect(instance.getAccountToken(token.oid)).resolves.toMatchObject(token);
      expect(durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM credential_mirror_queue WHERE account_id=?",
        token.oid,
      ).one().count).toBe(1);

      failPut = false;
      durableState.storage.sql.exec(
        "UPDATE credential_mirror_queue SET next_attempt_at=0 WHERE account_id=?",
        token.oid,
      );
      await instance.alarm();
      const stored = durableState.storage.sql.exec<{ token_cipher: string; credential_kv_key: string }>(
        "SELECT token_cipher,credential_kv_key FROM accounts WHERE id=?",
        token.oid,
      ).one();
      expect(mirrored.get(stored.credential_kv_key)).toBe(stored.token_cipher);
      expect(durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM credential_mirror_queue WHERE account_id=?",
        token.oid,
      ).one().count).toBe(0);
    });
  });

  it("atomically migrates a legacy kv-only row without exposing plaintext", async () => {
    const state = env.TENANTS.getByName(`credential-legacy-${crypto.randomUUID()}`);
    await state.listAccounts();
    const token = testToken(`legacy-${crypto.randomUUID()}`);
    const encrypted = await encryptJSON(token, env.DATA_ENCRYPTION_KEY);
    const legacyKey = `account-credential:legacy-${crypto.randomUUID()}`;
    await env.SENSITIVE_KV.put(legacyKey, encrypted);

    await runInDurableObject(state, (_instance, durableState) => {
      durableState.storage.sql.exec(
        `INSERT INTO accounts(id,email,display_name,expires_at,updated_at,token_cipher,credential_revision,credential_kv_key,sequence_no)
         VALUES(?,?,?,?,?,?,0,'',1)`,
        token.oid,
        token.email,
        token.displayName,
        token.expiresAt,
        Date.now(),
        `kv:${legacyKey}`,
      );
    });

    await expect(state.getAccountToken(token.oid)).resolves.toMatchObject(token);
    await runInDurableObject(state, (_instance, durableState) => {
      const stored = durableState.storage.sql.exec<{
        token_cipher: string;
        credential_kv_key: string;
        credential_revision: number;
      }>("SELECT token_cipher,credential_kv_key,credential_revision FROM accounts WHERE id=?", token.oid).one();
      expect(stored.token_cipher).toBe(encrypted);
      expect(stored.token_cipher).not.toContain(token.accessToken);
      expect(stored.token_cipher).not.toContain(token.email);
      expect(stored.credential_kv_key).toBe(legacyKey);
      expect(stored.credential_revision).toBe(1);
    });
    // The second read is now strongly consistent and no longer depends on KV.
    await env.SENSITIVE_KV.delete(legacyKey);
    await expect(state.getAccountToken(token.oid)).resolves.toMatchObject(token);
  });

  it("treats an unavailable legacy mirror as transient instead of isolating the account", async () => {
    const state = env.TENANTS.getByName(`credential-legacy-missing-${crypto.randomUUID()}`);
    await state.listAccounts();
    const token = testToken(`legacy-missing-${crypto.randomUUID()}`);
    await runInDurableObject(state, (_instance, durableState) => {
      durableState.storage.sql.exec(
        `INSERT INTO accounts(id,email,display_name,expires_at,updated_at,token_cipher,credential_revision,credential_kv_key,sequence_no)
         VALUES(?,?,?,?,?,?,0,'',1)`,
        token.oid,
        token.email,
        token.displayName,
        token.expiresAt,
        Date.now(),
        `kv:account-credential:missing-${crypto.randomUUID()}`,
      );
    });

    await runInDurableObject(state, async (instance) => {
      await expect(instance.selectAccount(token.oid)).rejects.toThrow("ACCOUNT_CREDENTIAL_MIRROR_UNAVAILABLE");
      await expect(instance.accountAvailability(token.oid)).resolves.toMatchObject({ available: false, isolated: false });
    });
  });

  it("makes a refreshed credential visible to concurrent readers before its KV mirror completes", async () => {
    const state = env.TENANTS.getByName(`credential-refresh-read-${crypto.randomUUID()}`);
    const initial = testToken(`refresh-${crypto.randomUUID()}`);
    const fresh = { ...initial, accessToken: `fresh-access-${crypto.randomUUID()}`, expiresAt: Date.now() + 7_200_000 };
    const mirrorEntered = deferred();
    const releaseMirror = deferred();
    let putCount = 0;
    const slowKV = fakeKV({
      put: async () => {
        putCount += 1;
        if (putCount === 2) {
          mirrorEntered.resolve();
          await releaseMirror.promise;
        }
      },
    });

    await runInDurableObject(state, async (instance) => {
      replaceSensitiveKV(instance, slowKV);
      await instance.upsertAccount(initial);
      const refreshWrite = instance.upsertAccount(fresh, false);
      await mirrorEntered.promise;

      const reads = await Promise.all(Array.from({ length: 16 }, () => instance.getAccountToken(initial.oid)));
      expect(reads.every((token) => token?.accessToken === fresh.accessToken)).toBe(true);
      releaseMirror.resolve();
      await refreshWrite;
      await expect(instance.getAccountToken(initial.oid)).resolves.toMatchObject({ accessToken: fresh.accessToken });
    });
  });

  it("single-flights an OAuth refresh while concurrent readers retain a complete credential", async () => {
    const state = env.TENANTS.getByName(`credential-refresh-singleflight-${crypto.randomUUID()}`);
    const initial = testToken(`singleflight-${crypto.randomUUID()}`, { expiresAt: Date.now() - 1_000 });
    await state.upsertAccount(initial);
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    const freshAccessToken = unsignedJWT({
      oid: initial.oid,
      tid: initial.tid,
      preferred_username: initial.email,
      name: initial.displayName,
    });
    const fetchMock = vi.fn(async () => {
      refreshEntered.resolve();
      await releaseRefresh.promise;
      return Response.json({
        access_token: freshAccessToken,
        refresh_token: `new-${initial.refreshToken}`,
        expires_in: 3_600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await runInDurableObject(state, async (instance) => {
        const first = instance.ensureValidAccount(initial.oid);
        const second = instance.ensureValidAccount(initial.oid);
        await refreshEntered.promise;

        const during = await Promise.all(Array.from({ length: 12 }, () => instance.getAccountToken(initial.oid)));
        expect(during.every((token) => token?.accessToken === initial.accessToken)).toBe(true);
        releaseRefresh.resolve();
        const [left, right] = await Promise.all([first, second]);
        expect(left?.accessToken).toBe(freshAccessToken);
        expect(right?.accessToken).toBe(freshAccessToken);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await expect(instance.getAccountToken(initial.oid)).resolves.toMatchObject({
          accessToken: freshAccessToken,
          refreshToken: `new-${initial.refreshToken}`,
        });
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deletes authoritative credentials and retries KV cleanup without reviving an account", async () => {
    const state = env.TENANTS.getByName(`credential-delete-${crypto.randomUUID()}`);
    const token = testToken(`delete-${crypto.randomUUID()}`);
    let failDelete = true;
    const values = new Map<string, string>();
    const flakyKV = fakeKV({
      put: async (key, value) => { values.set(key, value); },
      delete: async (key) => {
        if (failDelete) throw new Error("simulated delete outage");
        values.delete(key);
      },
    });

    await runInDurableObject(state, async (instance, durableState) => {
      replaceSensitiveKV(instance, flakyKV);
      await instance.upsertAccount(token);
      expect(values.size).toBe(1);
      await expect(instance.deleteAccount(token.oid)).resolves.toBe(true);
      await expect(instance.getAccountToken(token.oid)).resolves.toBeNull();
      expect(durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM credential_mirror_deletions WHERE account_id=?",
        token.oid,
      ).one().count).toBe(1);

      failDelete = false;
      durableState.storage.sql.exec(
        "UPDATE credential_mirror_deletions SET next_attempt_at=0 WHERE account_id=?",
        token.oid,
      );
      await instance.alarm();
      expect(values.size).toBe(0);
      expect(durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM credential_mirror_deletions WHERE account_id=?",
        token.oid,
      ).one().count).toBe(0);
    });
  });

  it("does not let delayed KV deletion erase a re-authorized account mirror", async () => {
    const state = env.TENANTS.getByName(`credential-delete-reauthorize-${crypto.randomUUID()}`);
    const initial = testToken(`reauthorize-${crypto.randomUUID()}`);
    const fresh = { ...initial, accessToken: `reauthorized-${crypto.randomUUID()}`, expiresAt: Date.now() + 7_200_000 };
    const values = new Map<string, string>();
    const flakyKV = fakeKV({
      put: async (key, value) => { values.set(key, value); },
      delete: async () => { throw new Error("simulated delayed delete"); },
    });

    await runInDurableObject(state, async (instance, durableState) => {
      replaceSensitiveKV(instance, flakyKV);
      await instance.upsertAccount(initial);
      const originalKey = durableState.storage.sql.exec<{ credential_kv_key: string }>(
        "SELECT credential_kv_key FROM accounts WHERE id=?",
        initial.oid,
      ).one().credential_kv_key;
      await instance.deleteAccount(initial.oid);
      expect(durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM credential_mirror_deletions WHERE account_id=?",
        initial.oid,
      ).one().count).toBe(1);

      await instance.upsertAccount(fresh);
      const restored = durableState.storage.sql.exec<{ token_cipher: string; credential_kv_key: string }>(
        "SELECT token_cipher,credential_kv_key FROM accounts WHERE id=?",
        initial.oid,
      ).one();
      expect(restored.credential_kv_key).toBe(originalKey);
      expect(values.get(originalKey)).toBe(restored.token_cipher);
      expect(durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM credential_mirror_deletions WHERE account_id=?",
        initial.oid,
      ).one().count).toBe(0);
      await instance.alarm();
      expect(values.get(originalKey)).toBe(restored.token_cipher);
      await expect(instance.getAccountToken(initial.oid)).resolves.toMatchObject({ accessToken: fresh.accessToken });
    });
  });

  it.each([
    { name: "a corrupted ciphertext", corrupt: true },
    { name: "the wrong encryption key", corrupt: false },
  ])("securely isolates $name without returning credential material", async ({ corrupt }) => {
    const state = env.TENANTS.getByName(`credential-corrupt-${crypto.randomUUID()}`);
    const token = testToken(`corrupt-${crypto.randomUUID()}`);
    await state.upsertAccount(token);

    await runInDurableObject(state, async (instance, durableState) => {
      if (corrupt) {
        durableState.storage.sql.exec(
          "UPDATE accounts SET token_cipher='invalid-aes-gcm-ciphertext' WHERE id=?",
          token.oid,
        );
      } else {
        const internal = instance as unknown as { env: Env };
        internal.env = {
          ...internal.env,
          DATA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        };
      }
      let message = "";
      try {
        await instance.selectAccount(token.oid);
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }
      expect(message).toBe("ACCOUNT_CREDENTIAL_CORRUPT");
      expect(message).not.toContain(token.accessToken);
      expect(message).not.toContain(token.refreshToken);
      expect(message).not.toContain(token.email);
      await expect(instance.accountAvailability(token.oid)).resolves.toMatchObject({ available: false, isolated: true });
    });
  });
});
