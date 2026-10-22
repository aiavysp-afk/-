import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRenderer } from "./test-hook-renderer";
import {
  BrowserLogin,
  loginRequest,
  StaffPasswordCredentialsFields,
} from "./browser-login";

const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => hooks.current!.useState(initial),
    useMemo: (...args: Parameters<typeof actual.useMemo>) =>
      hooks.current!.useMemo(...args),
    useRef: (...args: Parameters<typeof actual.useRef>) =>
      hooks.current!.useRef(...args),
    useEffect: (...args: Parameters<typeof actual.useEffect>) =>
      hooks.current!.useEffect(args[0], args[1] ?? []),
  };
});

type Node = { type: unknown; props: Record<string, any> };
const flush = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
const flushMicrotasks = async () => {
  for (let index = 0; index < 40; index++) await Promise.resolve();
};
function controlTimeouts() {
  vi.useFakeTimers();
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(new DOMException("fixture deadline", "TimeoutError")),
      milliseconds,
    );
    return controller.signal;
  });
}
function waitForAbort(_input: RequestInfo | URL, options?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    const signal = options?.signal;
    if (!signal) throw Error("Fixture expects a bounded request signal");
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const validPair = () => ({
  pairCode: "p".repeat(22),
  browserSecret: "s".repeat(43),
  confirmationCode: "000001",
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
});
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return text((value as Node).props?.children);
}
function render() {
  return hooks.current!.render(() =>
    BrowserLogin({ onSession: () => {}, allowWechat: true }),
  );
}
function startButton(tree: unknown) {
  const button = nodes(tree).find(
    (node) => node.type === "button" && text(node) === "发起微信后台登录",
  );
  expect(button).toBeDefined();
  return button!;
}
async function ready(response: Response) {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ enabled: true, provider: "wechat" }))
    .mockResolvedValueOnce(json({ enabled: false, smsEnabled: false }))
    .mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  render();
  hooks.current!.flushEffects();
  await flush();
  nodes(render())
    .find(
      (node) => node.props.role === "tab" && text(node).includes("微信登录"),
    )!
    .props.onClick();
  return fetcher;
}

beforeEach(() => {
  hooks.current = createHookRenderer();
});
afterEach(() => {
  hooks.current?.unmount();
  hooks.current = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("staff login transport failures are actionable, not silent", () => {
  it("identifies a non-JSON HTTP 503 as possible network restriction or temporary service failure", async () => {
    const fetcher = vi.fn(
      async () => new Response("maintenance", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      loginRequest("/auth/browser-login/create", {}),
    ).rejects.toThrow(/HTTP 503.*网络.*管理员/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HTML", "<html>unexpected successful fallback</html>"],
    ["missing data", JSON.stringify({ unexpected: true })],
    ["null data", JSON.stringify({ data: null })],
    ["null envelope", "null"],
  ])(
    "rejects an HTTP 200 %s response rather than returning an absent challenge",
    async (_name, body) => {
      const fetcher = vi.fn(async () => new Response(body));
      vi.stubGlobal("fetch", fetcher);
      await expect(
        loginRequest("/auth/browser-login/create", {}),
      ).rejects.toThrow(/响应格式异常/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts a pending login fetch at 15 seconds, without retrying the POST", async () => {
    const timeout = controlTimeouts();
    const fetcher = vi.fn(waitForAbort);
    vi.stubGlobal("fetch", fetcher);
    let settled = false;
    const result = loginRequest("/auth/browser-login/create", {});
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(result).rejects.toThrow(/请求超时.*重试/);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(settled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const options = fetcher.mock.calls[0]![1];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.body).toBe("{}");
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it("also aborts response.json while a real response stream is still being read", async () => {
    controlTimeouts();
    let bodyStarted = false;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, options?: RequestInit) => {
        const signal = options?.signal!;
        const response = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'));
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true },
              );
            },
          }),
        );
        const parseBody = response.json.bind(response);
        vi.spyOn(response, "json").mockImplementation(() => {
          bodyStarted = true;
          return parseBody();
        });
        return response;
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const result = loginRequest("/auth/browser-login/create", {});
    const rejected = expect(result).rejects.toThrow(/请求超时.*重试/);
    await flushMicrotasks();
    expect(bodyStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("replaces browser-specific network diagnostics with a safe retry hint", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      loginRequest("/auth/browser-login/create", {}),
    ).rejects.toThrow(/网络.*重试/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves meaningful JSON rejection messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "登录来源不受信任" }), {
            status: 403,
          }),
      ),
    );
    await expect(
      loginRequest("/auth/browser-login/create", {}),
    ).rejects.toThrow("登录来源不受信任");
  });
});

describe("actual WeChat start response state", () => {
  it("shows a blocked HTTP 503 and allows an explicit retry without automatically creating more attempts", async () => {
    const fetcher = await ready(new Response("maintenance", { status: 503 }));
    startButton(render()).props.onClick();
    await flush();
    const failed = render();
    expect(text(failed)).toContain("HTTP 503");
    expect(text(failed)).toContain("网络可能未获准访问后台");
    expect(startButton(failed).props.disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockResolvedValueOnce(json(validPair()));
    startButton(failed).props.onClick();
    await flush();
    expect(
      nodes(render()).some(
        (node) => node.props.className === "login-pair-code",
      ),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["missing pair code", () => ({ ...validPair(), pairCode: undefined })],
    ["invalid pair code", () => ({ ...validPair(), pairCode: "short" })],
    [
      "invalid browser proof",
      () => ({ ...validPair(), browserSecret: "short" }),
    ],
    [
      "invalid confirmation digits",
      () => ({ ...validPair(), confirmationCode: "not-six-digits" }),
    ],
    ["invalid expiry", () => ({ ...validPair(), expiresAt: "not-a-date" })],
  ])(
    "reports %s instead of rendering an unusable pairing flow",
    async (_name, pair) => {
      const fetcher = await ready(json(pair()));
      startButton(render()).props.onClick();
      await flush();
      const tree = render();
      expect(text(tree)).toContain("响应格式异常");
      expect(
        nodes(tree).some((node) => node.props.className === "login-pair-code"),
      ).toBe(false);
      expect(startButton(tree).props.disabled).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it.each([-240_000, 240_000])(
    "does not reject a server-issued pair when the computer clock is offset by %s ms",
    async (offset) => {
      const serverNow = Date.now();
      const pair = {
        ...validPair(),
        expiresAt: new Date(serverNow + 180_000).toISOString(),
      };
      vi.spyOn(Date, "now").mockReturnValue(serverNow + offset);
      const fetcher = await ready(json(pair));
      startButton(render()).props.onClick();
      await flush();
      const tree = render();
      expect(
        nodes(tree).some((node) => node.props.className === "login-pair-code"),
      ).toBe(true);
      expect(nodes(tree).some((node) => node.props.role === "alert")).toBe(
        false,
      );
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it("releases the busy state after a real deadline and retries only after the user explicitly asks", async () => {
    const fetcher = await ready(json(validPair()));
    fetcher.mockReset().mockImplementationOnce(waitForAbort);
    controlTimeouts();
    startButton(render()).props.onClick();
    expect(startButton(render()).props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    const failed = render();
    expect(text(failed)).toContain("请求超时");
    expect(startButton(failed).props.disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(json(validPair()));
    startButton(render()).props.onClick();
    await flushMicrotasks();
    const retried = render();
    expect(
      nodes(retried).some((node) => node.props.className === "login-pair-code"),
    ).toBe(true);
    expect(nodes(retried).some((node) => node.props.role === "alert")).toBe(
      false,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("displays a real valid challenge without retrying or changing its proof", async () => {
    const pair = validPair();
    const fetcher = await ready(json(pair));
    startButton(render()).props.onClick();
    await flush();
    const tree = render();
    expect(text(tree)).toContain(pair.pairCode);
    expect(text(tree)).toContain(pair.confirmationCode);
    expect(nodes(tree).some((node) => node.props.role === "alert")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

function buttonWithText(tree: unknown, label: string) {
  const button = nodes(tree).find(
    (node) => node.type === "button" && text(node) === label,
  );
  expect(button).toBeDefined();
  return button!;
}
async function openPasswordForm() {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ enabled: true, provider: "wechat" }))
    .mockResolvedValueOnce(json({ enabled: true, smsEnabled: true }));
  vi.stubGlobal("fetch", fetcher);
  render();
  hooks.current!.flushEffects();
  await flush();
  nodes(render())
    .find(
      (node) =>
        node.props.role === "tab" && text(node).includes("账号密码登录"),
    )!
    .props.onClick();
  return fetcher;
}

describe("first-use password login guidance", () => {
  it("explains a short password and account format instead of showing an unexplained disabled button", async () => {
    const fetcher = await openPasswordForm();
    let fields = nodes(render()).find(
      (node) => node.type === StaffPasswordCredentialsFields,
    )!;
    fields.props.onAccountChange("admin");
    fields = nodes(render()).find(
      (node) => node.type === StaffPasswordCredentialsFields,
    )!;
    fields.props.onPasswordChange("000001");
    const tree = render();
    expect(buttonWithText(tree, "验证密码并发送短信").props.disabled).toBe(
      true,
    );
    expect(text(tree)).toContain("12–128");
    expect(text(tree)).toContain("密码至少12位");
    expect(text(tree)).toContain("默认使用已绑定的11位手机号");
    expect(text(tree)).toContain("已有用户名仍可继续使用");
    expect(text(tree)).not.toContain("000001");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps disabled first setup accurate and WeChat explicitly optional without sending SMS", async () => {
    const fetcher = await openPasswordForm();
    const tree = render();
    expect(text(tree)).toContain("首次设置账号密码尚未启用");
    expect(text(tree)).not.toContain("首次使用请先完成微信登录");
    expect(buttonWithText(tree, "首次设置账号密码").props.disabled).toBe(true);
    nodes(tree)
      .find(
        (node) => node.props.role === "tab" && text(node).includes("微信登录"),
      )!
      .props.onClick();
    const wechat = nodes(render()).find(
      (node) => node.props.role === "tab" && text(node).includes("微信登录"),
    );
    expect(wechat?.props["aria-selected"]).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("server-rejected pairing recovery is manual and clears the obsolete proof", () => {
  it.each([
    { status: 401, stage: "poll", clear: true },
    { status: 409, stage: "claim", clear: true },
    { status: 200, stage: "poll", clear: false },
    { status: 503, stage: "poll", clear: false },
  ])(
    "preserves known HTTP $status when a slow $stage body times out, clearing the proof only for server rejection",
    async ({ status, stage, clear }) => {
      const fetcher = await ready(json(validPair()));
      startButton(render()).props.onClick();
      await flush();
      controlTimeouts();
      if (stage === "claim")
        fetcher.mockResolvedValueOnce(json({ status: "APPROVED" }));
      let bodyStarted = false;
      fetcher.mockImplementationOnce(
        async (url: RequestInfo | URL, options?: RequestInit) => {
          expect(String(url)).toMatch(new RegExp(`/${stage}$`));
          const signal = options?.signal!;
          const response = new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"data":'));
                signal.addEventListener(
                  "abort",
                  () => controller.error(signal.reason),
                  { once: true },
                );
              },
            }),
            { status },
          );
          const parseBody = response.json.bind(response);
          vi.spyOn(response, "json").mockImplementation(() => {
            bodyStarted = true;
            return parseBody();
          });
          return response;
        },
      );
      buttonWithText(render(), "我已在小程序确认").props.onClick();
      await flushMicrotasks();
      expect(bodyStarted).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);
      const tree = render();
      expect(text(tree)).toContain("请求超时");
      expect(
        nodes(tree).some((node) => node.props.className === "login-pair-code"),
      ).toBe(!clear);
      expect(
        buttonWithText(
          tree,
          clear ? "重新发起微信后台登录" : "我已在小程序确认",
        ).props.disabled,
      ).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(stage === "claim" ? 5 : 4);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher).toHaveBeenCalledTimes(stage === "claim" ? 5 : 4);
    },
  );

  it("keeps a pending pair for manual confirmation checks without claiming or regenerating it", async () => {
    const fetcher = await ready(json(validPair()));
    startButton(render()).props.onClick();
    await flush();
    fetcher.mockResolvedValueOnce(json({ status: "PENDING" }));
    buttonWithText(render(), "我已在小程序确认").props.onClick();
    await flush();
    const tree = render();
    expect(text(tree)).toContain("尚待小程序确认");
    expect(
      nodes(tree).some((node) => node.props.className === "login-pair-code"),
    ).toBe(true);
    expect(buttonWithText(tree, "我已在小程序确认").props.disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([429, 503])(
    "does not discard a pair just because the poll receives HTTP %s",
    async (status) => {
      const fetcher = await ready(json(validPair()));
      startButton(render()).props.onClick();
      await flush();
      fetcher.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "请稍后重试" }), { status }),
      );
      buttonWithText(render(), "我已在小程序确认").props.onClick();
      await flush();
      const tree = render();
      expect(
        nodes(tree).some((node) => node.props.className === "login-pair-code"),
      ).toBe(true);
      expect(buttonWithText(tree, "我已在小程序确认").props.disabled).toBe(
        false,
      );
      expect(fetcher).toHaveBeenCalledTimes(4);
    },
  );

  it("keeps HTTP status structured without losing the server's safe error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ message: "登录配对已过期或无效，请重新发起" }),
            { status: 401 },
          ),
      ),
    );
    await expect(
      loginRequest("/auth/browser-login/poll", {}),
    ).rejects.toMatchObject({
      status: 401,
      message: "登录配对已过期或无效，请重新发起",
    });
  });

  it("clears a server-expired pair and offers a manual restart without automatically cancelling, claiming or retrying", async () => {
    const fetcher = await ready(json(validPair()));
    startButton(render()).props.onClick();
    await flush();
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "登录配对已过期或无效，请重新发起" }),
        { status: 401 },
      ),
    );
    buttonWithText(render(), "我已在小程序确认").props.onClick();
    await flush();
    const tree = render();
    expect(
      nodes(tree).some((node) => node.props.className === "login-pair-code"),
    ).toBe(false);
    expect(text(tree)).toContain("已过期");
    expect(buttonWithText(tree, "重新发起微信后台登录").props.disabled).toBe(
      false,
    );
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mockResolvedValueOnce(json(validPair()));
    buttonWithText(tree, "重新发起微信后台登录").props.onClick();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(
      nodes(render()).some(
        (node) => node.props.className === "login-pair-code",
      ),
    ).toBe(true);
  });

  it.each(["CONSUMED", "CANCELLED"])(
    "clears terminal %s without trying to claim it",
    async (status) => {
      const fetcher = await ready(json(validPair()));
      startButton(render()).props.onClick();
      await flush();
      fetcher.mockResolvedValueOnce(json({ status }));
      buttonWithText(render(), "我已在小程序确认").props.onClick();
      await flush();
      const tree = render();
      expect(
        nodes(tree).some((node) => node.props.className === "login-pair-code"),
      ).toBe(false);
      expect(buttonWithText(tree, "重新发起微信后台登录").props.disabled).toBe(
        false,
      );
      expect(fetcher).toHaveBeenCalledTimes(4);
    },
  );

  it("does not repeat a claim rejected as already consumed or cancelled", async () => {
    const fetcher = await ready(json(validPair()));
    startButton(render()).props.onClick();
    await flush();
    fetcher.mockResolvedValueOnce(json({ status: "APPROVED" }));
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "登录已领取或取消" }), {
        status: 409,
      }),
    );
    buttonWithText(render(), "我已在小程序确认").props.onClick();
    await flush();
    const tree = render();
    expect(
      nodes(tree).some((node) => node.props.className === "login-pair-code"),
    ).toBe(false);
    expect(buttonWithText(tree, "重新发起微信后台登录").props.disabled).toBe(
      false,
    );
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/claim")),
    ).toHaveLength(1);
  });
});
