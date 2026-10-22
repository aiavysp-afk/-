import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileForm, ReviewStatus } from "./h5-onboarding-page";
import { TechnicianPhoneLogin } from "./phone-onboarding-page";
import {
  isTechnicianPhone,
  phoneOnboardingPaths,
  phoneWorkbenchAllowed,
  readPhoneToken,
  storePhoneToken,
  technicianEntryRoute,
  technicianRequest,
  validPhoneChallenge,
} from "./phone-onboarding";
import type { H5OnboardingStatus } from "./h5-onboarding";
import { readFileSync } from "node:fs";
import mainSource from "./main.tsx?raw";
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const status = {
  stage: "PROFILE_REQUIRED",
  phoneMasked: "138****8000",
  application: null,
} as H5OnboardingStatus;
describe("phone onboarding routes, validation and static UI", () => {
  it("defaults both the root and onboarding entry to phone independently of old build channel", () => {
    for (const oldChannel of [true, false]) {
      expect(technicianEntryRoute("", "", oldChannel)).toBe("phone");
      expect(technicianEntryRoute("", "?source=onboarding", oldChannel)).toBe(
        "phone",
      );
    }
    expect(mainSource).toContain("technicianEntryRoute");
    expect(mainSource).toContain("<PhoneEntry />");
    expect(mainSource).not.toContain(
      "isOnboardingRoute(window.location.pathname",
    );
  });
  it("keeps old WeChat login and OAuth only as explicit alternatives", () => {
    expect(technicianEntryRoute("", "?login=wechat", false)).toBe(
      "wechat-workbench",
    );
    expect(
      technicianEntryRoute("#/wechat-callback?ticket=synthetic", "", true),
    ).toBe("wechat-onboarding");
    expect(
      technicianEntryRoute("#/wechat-callback?ticket=synthetic", "", false),
    ).toBe("miniapp");
    expect(technicianEntryRoute("#/configuration-unavailable", "", false)).toBe(
      "miniapp",
    );
  });
  it("keeps SMS authentication separate from OAuth and customer SMS", () => {
    const paths = phoneOnboardingPaths();
    expect(paths.smsRequest).toBe("/auth/technician-phone/sms/request");
    expect(paths.smsConfirm).toBe("/auth/technician-phone/sms/confirm");
    expect(paths.status).toBe("/technician/phone-onboarding/status");
    expect(paths.submit).toBe("/technician/phone-onboarding/submit");
  });
  it.each(["", "123", "138001380000", "+8613800138000", "138 0013 8000"])(
    "rejects malformed phone %s",
    (phone) => expect(isTechnicianPhone(phone)).toBe(false),
  );
  it("accepts only a strict unexpired server challenge", () => {
    const challenge = {
      challengeId: "11111111-1111-4111-8111-111111111111",
      challengeSecret: "s".repeat(43),
      maskedPhone: "138****8000",
      expiresAt: "2099-01-01T00:00:00Z",
      retryAfterSeconds: 60,
    };
    expect(validPhoneChallenge(challenge)).toBe(true);
    for (const change of [
      { challengeId: "x" },
      { challengeSecret: "s" },
      { expiresAt: "2020-01-01" },
      { retryAfterSeconds: -1 },
      { retryAfterSeconds: 9999 },
    ])
      expect(validPhoneChallenge({ ...challenge, ...change })).toBe(false);
  });
  it("renders visible passwordless entry with all agreements unchecked and no hidden automatic authorization", () => {
    const markup = renderToStaticMarkup(
      <TechnicianPhoneLogin
        capabilities={{ enabled: true, workbenchEnabled: true }}
        loading={false}
        error=""
        onRetry={vi.fn()}
        onAuthenticated={vi.fn()}
      />,
    );
    expect(markup).toContain("手机号验证，即可登记");
    expect(markup).toContain("获取验证码");
    expect(markup).toContain("验证并进入入驻资料");
    for (const label of ["用户协议", "隐私政策", "上门服务公约"])
      expect(markup).toContain(label);
    expect(markup).toContain('type="checkbox"');
    expect(markup).not.toContain("checked=");
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain("微信授权并开始入驻");
    expect(markup).not.toContain("challengeSecret");
  });
  it("explains a closed deployment gate instead of opening a dead OAuth route", () => {
    const markup = renderToStaticMarkup(
      <TechnicianPhoneLogin
        capabilities={{ enabled: false, workbenchEnabled: false }}
        loading={false}
        error=""
        onRetry={vi.fn()}
        onAuthenticated={vi.fn()}
      />,
    );
    expect(markup).toContain("手机号入驻通道尚未开放");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("api.mtsc.top");
  });
  it("renders required personal fields, image and camera controls with explicit photo consent", () => {
    const markup = renderToStaticMarkup(
      <ProfileForm
        token="synthetic"
        status={status}
        services={[{ id: "svc", name: "中式推拿", durationMinutes: 60 }]}
        paths={phoneOnboardingPaths()}
        allowDraftSave
        onUpdated={vi.fn()}
        onExpired={vi.fn()}
      />,
    );
    for (const label of [
      "真实姓名",
      "服务城市",
      "接单区域",
      "可接单时间段",
      "个人简介",
      "擅长项目",
      "本人形象照",
      "身份证正面",
      "身份证反面",
      "保存文字草稿",
      "提交后台审核",
    ])
      expect(markup).toContain(label);
    expect(markup.match(/capture="environment"/g)).toHaveLength(3);
    expect(markup.match(/type="file"/g)).toHaveLength(6);
    expect(markup).toContain("仅限实名认证与资质审核，不对客户公开");
    expect(markup).toContain("本人同意形象照");
  });
  it("pending copy does not require a WeChat identity or expose document URLs", () => {
    const markup = renderToStaticMarkup(
      <ReviewStatus
        status={{ ...status, stage: "PENDING_REVIEW" }}
        phoneOnly
        onRefresh={vi.fn()}
      />,
    );
    expect(markup).toContain("同一手机号验证");
    expect(markup).not.toContain("同一微信");
    expect(markup).not.toContain("身份证正面URL");
  });
  it("keeps a usable 375px phone layout and readable 16px form fields", () => {
    expect(styles).toMatch(
      /\.technician-onboarding\s*\{[^}]*max-width:\s*520px/s,
    );
    expect(styles).toMatch(
      /\.phone-onboarding \.onboarding-code-field > span\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 112px/s,
    );
    expect(styles).toMatch(
      /\.phone-onboarding \.onboarding-field input,[^{]*\{[^}]*font-size:\s*16px/s,
    );
  });
  it("does not treat approved state alone as permission to open the workbench", () => {
    expect(
      phoneWorkbenchAllowed(
        { enabled: true, workbenchEnabled: false },
        { ...status, stage: "APPROVED" },
      ),
    ).toBe(false);
    expect(
      phoneWorkbenchAllowed(
        { enabled: true, workbenchEnabled: true },
        { ...status, stage: "PENDING_REVIEW" },
      ),
    ).toBe(false);
  });
  it("stores only the session token in sessionStorage and never requires localStorage", () => {
    const setItem = vi.fn(),
      removeItem = vi.fn();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: vi.fn(() => "synthetic-token"),
        setItem,
        removeItem,
      },
    });
    expect(readPhoneToken()).toBe("synthetic-token");
    storePhoneToken("next-synthetic-token");
    storePhoneToken("");
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledTimes(1);
    expect(setItem.mock.calls[0]).toEqual([
      "zydj.technician.phone-session-token",
      "next-synthetic-token",
    ]);
  });
});
describe("bounded onboarding request", () => {
  it("uses no ambient cookies, redirect following or invented proxy identity", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { ok: true } }),
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      technicianRequest(
        "/technician/phone-onboarding/status",
        {},
        "synthetic-token",
      ),
    ).resolves.toEqual({ ok: true });
    const options = fetcher.mock.calls[0]![1];
    expect(options.credentials).toBe("omit");
    expect(options.redirect).toBe("error");
    expect(options.headers.Authorization).toBe("Bearer synthetic-token");
    expect(options.headers).not.toHaveProperty("X-Forwarded-For");
  });
  it("returns error status without silently creating a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: "会话已过期" }),
      }),
    );
    await expect(technicianRequest("/test")).rejects.toMatchObject({
      status: 401,
      message: "会话已过期",
    });
  });
  it("aborts after fifteen seconds and never retries a POST automatically", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = technicianRequest("/auth/technician-phone/sms/request", {
      method: "POST",
      body: "{}",
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(((await result) as Error).message).toContain("请求超时");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403])(
    "preserves known %s even when the error body never completes",
    async (status) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({
            ok: false,
            status,
            json: () => new Promise(() => {}),
          }),
      );
      const result = technicianRequest(
        "/technician/phone-onboarding/status",
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ status });
    },
  );
  it.each([null, [], "bad envelope"])(
    "safely rejects malformed successful envelope %j",
    async (value) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => value,
          }),
      );
      await expect(technicianRequest("/test")).rejects.toThrow(
        "服务器返回不完整",
      );
    },
  );
});
