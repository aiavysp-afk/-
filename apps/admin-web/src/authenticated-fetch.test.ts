import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticatedFetch,
  createAdminSessionMonitor,
  registerAdminSession,
} from "./authenticated-fetch";

afterEach(() => {
  registerAdminSession("", () => {})();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("private admin session confirmation", () => {
  it("keeps a valid identity after a business/MFA 401 and does not treat 403 as logout", async () => {
    const probe = vi.fn(async () => 200),
      expired = vi.fn();
    const monitor = createAdminSessionMonitor(probe);
    monitor.register("staff-a", expired);
    await monitor.capture("staff-a")(403);
    expect(probe).not.toHaveBeenCalled();
    await monitor.capture("staff-a")(401);
    expect(probe).toHaveBeenCalledOnce();
    expect(expired).not.toHaveBeenCalled();
  });

  it("clears only after auth/me confirms 401; direct auth/me 401 needs no duplicate probe", async () => {
    const probe = vi.fn(async () => 401),
      expired = vi.fn();
    const monitor = createAdminSessionMonitor(probe);
    monitor.register("staff-a", expired);
    await monitor.capture("staff-a")(401);
    expect(expired).toHaveBeenCalledOnce();
    const nextExpired = vi.fn();
    monitor.register("staff-b", nextExpired);
    await monitor.capture("staff-b")(401, true);
    expect(probe).toHaveBeenCalledOnce();
    expect(nextExpired).toHaveBeenCalledOnce();
  });

  it.each([403, 503])(
    "retains the identity when confirmation is %s",
    async (status) => {
      const expired = vi.fn(),
        monitor = createAdminSessionMonitor(async () => status);
      monitor.register("staff-a", expired);
      await monitor.capture("staff-a")(401);
      expect(expired).not.toHaveBeenCalled();
    },
  );

  it("retains the identity on a network/timeout failure and permits later confirmation", async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(Error("synthetic network failure"))
      .mockResolvedValueOnce(401);
    const expired = vi.fn(),
      monitor = createAdminSessionMonitor(probe);
    monitor.register("staff-a", expired);
    await monitor.capture("staff-a")(401);
    expect(expired).not.toHaveBeenCalled();
    await monitor.capture("staff-a")(401);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("deduplicates simultaneous confirmation and clears at most once", async () => {
    const pending = deferred<number>(),
      probe = vi.fn(() => pending.promise),
      expired = vi.fn();
    const monitor = createAdminSessionMonitor(probe);
    monitor.register("staff-a", expired);
    const first = monitor.capture("staff-a")(401),
      second = monitor.capture("staff-a")(401);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();
    pending.resolve(401);
    await Promise.all([first, second]);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("ignores old confirmations and old cleanup after a newer identity registers", async () => {
    const pending = deferred<number>(),
      expiredA = vi.fn(),
      expiredB = vi.fn();
    const monitor = createAdminSessionMonitor(async () => pending.promise);
    const releaseA = monitor.register("staff-a", expiredA);
    const request = monitor.capture("staff-a")(401);
    await Promise.resolve();
    monitor.register("staff-b", expiredB);
    releaseA();
    pending.resolve(401);
    await request;
    expect(expiredA).not.toHaveBeenCalled();
    expect(expiredB).not.toHaveBeenCalled();
    await monitor.capture("staff-b")(401, true);
    expect(expiredB).toHaveBeenCalledOnce();
  });

  it("ignores an old request even when the same token is registered in a new epoch", async () => {
    const expired = vi.fn(),
      probe = vi.fn(async () => 401),
      monitor = createAdminSessionMonitor(probe);
    monitor.register("staff-a", expired);
    const old = monitor.capture("staff-a");
    monitor.register("staff-a", expired);
    await old(401, true);
    expect(expired).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("closes the render/effect identity gap using the live identity guard", async () => {
    let currentToken = "staff-a";
    const expired = vi.fn(),
      probe = vi.fn(async () => 401),
      monitor = createAdminSessionMonitor(probe);
    monitor.register("staff-a", expired, () => currentToken === "staff-a");
    const old = monitor.capture("staff-a");
    currentToken = "staff-b";
    await old(401, true);
    expect(expired).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not attribute anonymous or foreign-token failures to the current session", async () => {
    const expired = vi.fn(),
      probe = vi.fn(async () => 401),
      monitor = createAdminSessionMonitor(probe);
    monitor.register("staff-a", expired);
    await monitor.capture(undefined)(401);
    await monitor.capture("staff-b")(401);
    expect(probe).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();
  });
});

describe("explicit authenticated transport", () => {
  it("never retries a failed mutation and uses only a no-store read-only identity probe", async () => {
    const expired = vi.fn();
    registerAdminSession("staff-a", expired);
    const failed = new Response("{}", { status: 401 });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const options = {
      method: "POST",
      body: "{}",
      headers: { Authorization: "Bearer staff-a" },
    };
    expect(
      await authenticatedFetch(
        "staff-a",
        "http://127.0.0.1:3100/v1/auth/mfa/verify",
        options,
      ),
    ).toBe(failed);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual([
      "http://127.0.0.1:3100/v1/auth/mfa/verify",
      options,
    ]);
    expect(fetcher.mock.calls[1]![0]).toBe("http://127.0.0.1:3100/v1/auth/me");
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      cache: "no-store",
      headers: { Authorization: "Bearer staff-a" },
    });
    expect(fetcher.mock.calls[1]![1]).not.toHaveProperty("body");
    expect(expired).not.toHaveBeenCalled();
  });
});
