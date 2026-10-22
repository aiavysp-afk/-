import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRenderer } from "./test-hook-renderer";
import {
  TechnicianPhoneLogin,
  TechnicianPhoneOnboarding,
} from "./phone-onboarding-page";
import { OnboardingProfileFields, ProfileForm } from "./h5-onboarding-page";
import { prepareTechnicianPhoto } from "./technician-photo";
import { phoneOnboardingPaths } from "./phone-onboarding";
import type { H5OnboardingStatus } from "./h5-onboarding";
vi.mock("./technician-photo", () => ({ prepareTechnicianPhoto: vi.fn() }));

const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (value: unknown) => hooks.current!.useState(value),
    useRef: (value: unknown) => hooks.current!.useRef(value),
    useMemo: (factory: () => unknown, dependencies: readonly unknown[]) =>
      hooks.current!.useMemo(factory, dependencies),
    useCallback: (callback: unknown, dependencies: readonly unknown[]) =>
      hooks.current!.useCallback(callback, dependencies),
    useEffect: (
      effect: () => void | (() => void),
      dependencies: readonly unknown[] = [],
    ) => hooks.current!.useEffect(effect, dependencies),
  };
});
type Node = { type: unknown; props: Record<string, any> };
function nodes(tree: any): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !tree.props) return [];
  return [tree, ...nodes(tree.props.children)];
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return typeof tree === "string" || typeof tree === "number"
    ? String(tree)
    : "";
}
function button(tree: Node, label: string) {
  const found = nodes(tree).find(
    (node) => node.type === "button" && text(node).includes(label),
  );
  if (!found) throw Error(`Button not found: ${label}`);
  return found;
}
function field(tree: Node, autocomplete: string) {
  const found = nodes(tree).find(
    (node) => node.type === "input" && node.props.autoComplete === autocomplete,
  );
  if (!found) throw Error(`Input not found: ${autocomplete}`);
  return found;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = async () => {
  for (let i = 0; i < 14; i++) await Promise.resolve();
};
const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ data }),
});
const challenge = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  challengeSecret: "s".repeat(43),
  maskedPhone: "138****8000",
  expiresAt: "2099-01-01T00:00:00Z",
  retryAfterSeconds: 60,
};
let renderer: ReturnType<typeof createHookRenderer>,
  fetcher: ReturnType<typeof vi.fn>,
  storage: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  renderer = createHookRenderer();
  hooks.current = renderer;
  storage = new Map();
  fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", {
    setInterval,
    clearInterval,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
});
afterEach(() => {
  renderer.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function loginHarness() {
  const authenticated = vi.fn();
  let enabled = true;
  const render = () => {
    const tree = renderer.render(() =>
      TechnicianPhoneLogin({
        capabilities: { enabled, workbenchEnabled: true },
        loading: false,
        error: "",
        onRetry: vi.fn(),
        onAuthenticated: authenticated,
      }),
    );
    renderer.flushEffects();
    return tree;
  };
  let tree = render();
  function fill() {
    field(tree, "tel").props.onChange({
      currentTarget: { value: "13800138000" },
    });
    tree = render();
    nodes(tree)
      .find((node) => node.type === "input" && node.props.type === "checkbox")!
      .props.onChange({ currentTarget: { checked: true } });
    tree = render();
    return tree;
  }
  return {
    render,
    fill,
    authenticated,
    disable: () => {
      enabled = false;
    },
  };
}
describe("technician phone login interaction isolation", () => {
  it("never sends on mount and requires explicit consent, phone and a click", async () => {
    const login = loginHarness();
    let tree = login.render();
    expect(fetcher).not.toHaveBeenCalled();
    expect(button(tree, "获取验证码").props.disabled).toBe(true);
    tree = login.fill();
    expect(button(tree, "获取验证码").props.disabled).toBe(false);
    fetcher.mockResolvedValue(response(challenge));
    button(tree, "获取验证码").props.onClick();
    await tick();
    tree = login.render();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      phone: "13800138000",
      agreementsAccepted: true,
    });
    expect(button(tree, "秒后重试").props.disabled).toBe(true);
    expect(storage.size).toBe(0);
  });
  it("uses a synchronous in-flight guard against double click before re-render", async () => {
    const login = loginHarness();
    const tree = login.fill();
    fetcher.mockReturnValue(deferred<unknown>().promise);
    const click = button(tree, "获取验证码").props.onClick;
    click();
    click();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("ignores a late challenge after phone change and keeps the shared cooldown", async () => {
    const login = loginHarness();
    let tree = login.fill();
    const waiting = deferred<unknown>();
    fetcher.mockReturnValue(waiting.promise);
    button(tree, "获取验证码").props.onClick();
    tree = login.render();
    field(tree, "tel").props.onChange({
      currentTarget: { value: "13900139000" },
    });
    tree = login.render();
    waiting.resolve(response(challenge));
    await tick();
    tree = login.render();
    expect(field(tree, "one-time-code").props.disabled).toBe(true);
    expect(button(tree, "秒后重试").props.disabled).toBe(true);
    expect(login.authenticated).not.toHaveBeenCalled();
  });
  it("never lets an old confirmation authenticate a changed phone and revokes the late session", async () => {
    const login = loginHarness();
    let tree = login.fill();
    fetcher.mockResolvedValueOnce(response(challenge));
    button(tree, "获取验证码").props.onClick();
    await tick();
    tree = login.render();
    field(tree, "one-time-code").props.onChange({
      currentTarget: { value: "123456" },
    });
    tree = login.render();
    const waiting = deferred<unknown>();
    fetcher.mockReturnValueOnce(waiting.promise);
    button(tree, "验证并进入").props.onClick();
    tree = login.render();
    field(tree, "tel").props.onChange({
      currentTarget: { value: "13900139000" },
    });
    tree = login.render();
    fetcher.mockResolvedValue(response({}));
    waiting.resolve(response({ accessToken: "late-synthetic-session" }));
    await tick();
    expect(login.authenticated).not.toHaveBeenCalled();
    expect(
      fetcher.mock.calls.some(
        (call) =>
          String(call[0]).endsWith("/auth/logout") &&
          call[1].headers.Authorization === "Bearer late-synthetic-session",
      ),
    ).toBe(true);
    expect(storage.size).toBe(0);
  });
  it("requires a server proof and exact six digits, then clears both code and challenge", async () => {
    const login = loginHarness();
    let tree = login.fill();
    expect(button(tree, "验证并进入").props.disabled).toBe(true);
    fetcher.mockResolvedValueOnce(response(challenge));
    button(tree, "获取验证码").props.onClick();
    await tick();
    tree = login.render();
    field(tree, "one-time-code").props.onChange({
      currentTarget: { value: "12345" },
    });
    tree = login.render();
    expect(button(tree, "验证并进入").props.disabled).toBe(true);
    field(tree, "one-time-code").props.onChange({
      currentTarget: { value: "123456" },
    });
    tree = login.render();
    expect(button(tree, "验证并进入").props.disabled).toBe(false);
    fetcher.mockResolvedValueOnce(
      response({ accessToken: "synthetic-session" }),
    );
    button(tree, "验证并进入").props.onClick();
    await tick();
    tree = login.render();
    expect(login.authenticated).toHaveBeenCalledWith({
      accessToken: "synthetic-session",
    });
    expect(field(tree, "one-time-code").props.value).toBe("");
    expect(field(tree, "one-time-code").props.disabled).toBe(true);
  });
  it("expires the proof and never automatically resends a code", async () => {
    const login = loginHarness();
    let tree = login.fill();
    fetcher.mockResolvedValueOnce(
      response({ ...challenge, expiresAt: "2030-01-01T00:00:02Z" }),
    );
    button(tree, "获取验证码").props.onClick();
    await tick();
    tree = login.render();
    await vi.advanceTimersByTimeAsync(2500);
    tree = login.render();
    expect(text(tree)).toContain("本次验证码已过期");
    expect(field(tree, "one-time-code").props.disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains cooldown on an uncertain timeout and offers a manual retry only", async () => {
    const login = loginHarness();
    let tree = login.fill();
    fetcher.mockReturnValue(new Promise(() => {}));
    button(tree, "获取验证码").props.onClick();
    await vi.advanceTimersByTimeAsync(15000);
    tree = login.render();
    expect(text(tree)).toContain("请求超时");
    expect(button(tree, "秒后重试").props.disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("ignores a late SMS response after unmount without persisting proof", async () => {
    const login = loginHarness();
    const tree = login.fill();
    const waiting = deferred<unknown>();
    fetcher.mockReturnValue(waiting.promise);
    button(tree, "获取验证码").props.onClick();
    renderer.unmount();
    waiting.resolve(response(challenge));
    await tick();
    expect(storage.size).toBe(0);
    expect(login.authenticated).not.toHaveBeenCalled();
  });
});
describe("restored technician identity and status isolation", () => {
  function page() {
    const tree = renderer.render(() =>
      TechnicianPhoneOnboarding({ onWorkbench: vi.fn() }),
    );
    renderer.flushEffects();
    return tree;
  }
  it.each([401, 403])(
    "recovers from a restored expired %s token to an enabled phone card",
    async (code) => {
      storage.set("zydj.technician.phone-session-token", "expired-synthetic");
      fetcher.mockImplementation(async (url: string) =>
        url.endsWith("/status")
          ? response({}, code)
          : response({ enabled: true, workbenchEnabled: true }),
      );
      page();
      await tick();
      page();
      await tick();
      const tree = page();
      const login = nodes(tree).find(
        (node) => node.type === TechnicianPhoneLogin,
      )!;
      expect(login.props.loading).toBe(false);
      expect(login.props.capabilities.enabled).toBe(true);
      expect(storage.size).toBe(0);
      expect(
        fetcher.mock.calls.filter((call) =>
          String(call[0]).endsWith("/status"),
        ),
      ).toHaveLength(1);
    },
  );
  it("clears all personal data before changing phone and ignores a late status", async () => {
    storage.set("zydj.technician.phone-session-token", "active-synthetic");
    const waiting = deferred<unknown>();
    fetcher.mockImplementation(async (url: string) =>
      url.endsWith("/status")
        ? waiting.promise
        : response({ enabled: true, workbenchEnabled: true }),
    );
    let tree = page();
    button(tree, "更换手机号").props.onClick();
    tree = page();
    await tick();
    waiting.resolve(
      response({
        stage: "PROFILE_REQUIRED",
        phoneMasked: "138****8000",
        application: {
          id: "private-person",
          realName: "SYNTHETIC_PRIVATE_NAME",
        },
      }),
    );
    await tick();
    tree = page();
    expect(nodes(tree).some((node) => node.type === TechnicianPhoneLogin)).toBe(
      true,
    );
    expect(text(tree)).not.toContain("SYNTHETIC_PRIVATE_NAME");
    expect(storage.size).toBe(0);
  });
  it("does not create a registration record automatically after a verified login", async () => {
    storage.set("zydj.technician.phone-session-token", "active-synthetic");
    fetcher.mockImplementation(async (url: string) =>
      url.endsWith("/status")
        ? response({ stage: "PROFILE_REQUIRED", application: null })
        : response({ enabled: true, workbenchEnabled: true }),
    );
    page();
    await tick();
    const tree = page();
    expect(button(tree, "新技师填写入驻资料")).toBeDefined();
    expect(
      fetcher.mock.calls.some((call) => String(call[0]).endsWith("/register")),
    ).toBe(false);
  });
  it("does not show the workbench button before the independent switch is enabled", async () => {
    storage.set("zydj.technician.phone-session-token", "active-synthetic");
    fetcher.mockImplementation(async (url: string) =>
      url.endsWith("/status")
        ? response({ stage: "APPROVED", application: null })
        : response({ enabled: true, workbenchEnabled: false }),
    );
    page();
    await tick();
    const tree = page();
    expect(text(tree)).toContain("网页接单工作台尚未开通");
    expect(
      nodes(tree).some(
        (node) =>
          node.type === "button" && text(node).includes("进入技师工作台"),
      ),
    ).toBe(false);
  });
});
describe("personal profile draft and upload races", () => {
  const complete = {
    realName: "测试技师",
    serviceCity: "郑州市",
    serviceAreas: ["金水区"],
    availableTimeSlots: ["MON:09:00-18:00"],
    bio: "本人擅长肩颈舒缓与中式推拿服务。",
    serviceIds: ["svc"],
  };
  const baseStatus = {
    stage: "PROFILE_REQUIRED",
    phoneMasked: "138****8000",
    application: {
      ...complete,
      id: "synthetic-application",
      status: "DRAFT",
      avatarUrl: "/synthetic-photo",
      hasIdFront: true,
      hasIdBack: true,
      galleryUrls: [],
      rejectionReason: null,
      version: 1,
      updatedAt: "2030-01-01",
    },
  } as H5OnboardingStatus;
  function formHarness() {
    const updated = vi.fn(),
      expired = vi.fn();
    const render = () => {
      const tree = renderer.render(() =>
        ProfileForm({
          token: "synthetic-profile-session",
          status: baseStatus,
          services: [{ id: "svc", name: "中式推拿" }],
          paths: phoneOnboardingPaths(),
          allowDraftSave: true,
          onUpdated: updated,
          onExpired: expired,
        }),
      );
      renderer.flushEffects();
      return tree;
    };
    return { render, updated, expired };
  }
  it("locks every field and image picker while saving, preventing double submissions before render", async () => {
    const form = formHarness();
    let tree = form.render();
    const waiting = deferred<unknown>();
    fetcher.mockReturnValue(waiting.promise);
    const save = button(tree, "保存文字草稿").props.onClick;
    save();
    save();
    tree = form.render();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      nodes(tree).find(
        (node) =>
          node.type === "fieldset" &&
          node.props.className === "onboarding-editable",
      )?.props.disabled,
    ).toBe(true);
    waiting.resolve(response(baseStatus));
    await tick();
    tree = form.render();
    expect(text(tree)).toContain("文字草稿已保存到后台，尚未提交审核");
    expect(form.updated).not.toHaveBeenCalled();
    expect(
      nodes(tree).find((node) => node.type === OnboardingProfileFields)!.props
        .draft,
    ).toEqual(complete);
  });
  it("only explicitly submits a complete form to the dedicated namespace", async () => {
    const form = formHarness();
    let tree = form.render();
    fetcher.mockImplementation(async (url: string) =>
      response(
        url.endsWith("/submit")
          ? { ...baseStatus, stage: "PENDING_REVIEW" }
          : baseStatus,
      ),
    );
    button(tree, "提交后台审核").props.onClick();
    await tick();
    tree = form.render();
    expect(form.updated).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "PENDING_REVIEW" }),
    );
    expect(
      fetcher.mock.calls.map((call) => String(call[0]).split("/v1")[1]),
    ).toEqual([
      "/technician/phone-onboarding/profile",
      "/technician/phone-onboarding/submit",
    ]);
  });
  it("does not continue a multi-step upload or expose data after logout/unmount", async () => {
    const form = formHarness();
    const tree = form.render();
    const waiting = deferred<unknown>();
    fetcher.mockReturnValue(waiting.promise);
    button(tree, "提交后台审核").props.onClick();
    renderer.unmount();
    waiting.resolve(response(baseStatus));
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(form.updated).not.toHaveBeenCalled();
  });
  it.each([401, 403])(
    "retires the phone identity on profile %s",
    async (status) => {
      const form = formHarness();
      const tree = form.render();
      fetcher.mockResolvedValue(response({}, status));
      button(tree, "保存文字草稿").props.onClick();
      await tick();
      expect(form.expired).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps the newest chosen photo when the old conversion finishes last", async () => {
    const form = formHarness();
    let tree = form.render();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const oldPhoto = deferred<string>(),
      newPhoto = deferred<string>();
    vi.mocked(prepareTechnicianPhoto)
      .mockReturnValueOnce(oldPhoto.promise)
      .mockReturnValueOnce(newPhoto.promise);
    const picker = () =>
      nodes(tree).find((node) => node.props.label === "本人形象照")!;
    const oldSelection = picker().props.onSelect({ name: "old.jpg" });
    tree = form.render();
    const newSelection = picker().props.onSelect({ name: "new.jpg" });
    tree = form.render();
    expect(button(tree, "正在处理照片").props.disabled).toBe(true);
    newPhoto.resolve("new-base64");
    await newSelection;
    tree = form.render();
    oldPhoto.resolve("old-base64");
    await oldSelection;
    tree = form.render();
    expect(picker().props.selected.name).toBe("new.jpg");
    expect(picker().props.selected.base64).toBe("new-base64");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
