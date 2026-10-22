import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffPasswordSettingsForm, StaffSecurity } from "./staff-security";
import { StaffPasswordCredentialsFields, loginRequest } from "./browser-login";
import { buildStaffPasswordUpdate } from "./staff-login-account";

afterEach(() => vi.unstubAllGlobals());

const blankDraft = { loginAlias: "admin", password: "", confirmation: "" };

describe("staff alias form rendering", () => {
  it("offers an uncommitted admin suggestion without setting a password or making any request", () => {
    const fetcher = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("localStorage", { setItem });
    vi.stubGlobal("sessionStorage", { setItem });
    const html = renderToStaticMarkup(
      <StaffPasswordSettingsForm
        draft={blankDraft}
        disabled={false}
        canSubmit={false}
        configured={false}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(html).toContain("登录用户名");
    expect(html).toContain('value="admin"');
    expect(html).toContain("本人点击保存后生效");
    expect(html).toContain("仍需本人绑定手机号短信二次验证");
    expect(html).toContain('minLength="12"');
    expect(html).toContain('maxLength="128"');
    expect(html).toContain('autoComplete="off"');
    expect(html).not.toContain('autoComplete="new-password"');
    expect(fetcher).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("displays an existing alias for explicit person-confirmed modification", () => {
    const html = renderToStaticMarkup(
      <StaffPasswordSettingsForm
        draft={{ ...blankDraft, loginAlias: "operator_01" }}
        disabled={false}
        canSubmit={false}
        configured
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(html).toContain('value="operator_01"');
    expect(html).toContain("修改本人用户名和密码");
  });

  it("does not invoke saving or expose editable fields without fresh TOTP", () => {
    const onSubmit = vi.fn();
    const draft = {
      ...blankDraft,
      password: "synthetic-password-42",
      confirmation: "synthetic-password-42",
    };
    const payload = buildStaffPasswordUpdate(draft, {
      enabled: true,
      maskedAccount: "138****8000",
      verifiedUntil: null,
      busy: false,
    });
    const form = StaffPasswordSettingsForm({
      draft,
      disabled: true,
      canSubmit: Boolean(payload),
      configured: true,
      onChange: () => {},
      onSubmit,
    });
    const preventDefault = vi.fn();
    form.props.onSubmit({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(form);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(4);
  });

  it("requires an explicit submit click even for a valid enabled form", () => {
    const onSubmit = vi.fn();
    const form = StaffPasswordSettingsForm({
      draft: {
        ...blankDraft,
        password: "synthetic-password-42",
        confirmation: "synthetic-password-42",
      },
      disabled: false,
      canSubmit: true,
      configured: false,
      onChange: () => {},
      onSubmit,
    });
    expect(onSubmit).not.toHaveBeenCalled();
    form.props.onSubmit({ preventDefault: () => {} });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("keeps security state unknown until real status is loaded, without assuming admin already exists", () => {
    const html = renderToStaticMarkup(
      <StaffSecurity token="synthetic-session" verifiedUntil={null} />,
    );
    expect(html).toContain("密码配置尚未读取成功");
    expect(html).not.toContain('value="admin"');
    expect(html).not.toContain("用户名和密码已更新");
  });
});

describe("username or phone credential fields", () => {
  it("renders admin in a text account input instead of an 11-digit numeric-only input", () => {
    const onAccountChange = vi.fn();
    const fields = StaffPasswordCredentialsFields({
      account: "admin",
      password: "",
      busy: false,
      onAccountChange,
      onPasswordChange: () => {},
    });
    const html = renderToStaticMarkup(fields);
    expect(html).toContain("登录账号");
    expect(html).toContain('placeholder="请输入已绑定手机号"');
    expect(html).toContain('type="text"');
    expect(html).toContain('value="admin"');
    expect(html).toContain('maxLength="32"');
    expect(html).not.toContain('type="tel"');
    const accountInput = fields.props.children[0].props.children[1];
    accountInput.props.onChange({ target: { value: "admin" } });
    expect(onAccountChange).toHaveBeenCalledWith("admin");
  });

  it("leaves the original phone option unchanged and never persists password mutations", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    vi.stubGlobal("sessionStorage", { setItem });
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { challengeId: "synthetic-challenge" } }),
    });
    vi.stubGlobal("fetch", fetcher);
    for (const account of ["admin", "13800138000"]) {
      await loginRequest("/auth/staff-password/login", {
        account,
        password: "synthetic-password-42",
      });
      const options = fetcher.mock.calls.at(-1)![1] as RequestInit;
      expect(options.cache).toBe("no-store");
      expect(options.body).toBe(
        JSON.stringify({ account, password: "synthetic-password-42" }),
      );
    }
    expect(setItem).not.toHaveBeenCalled();
  });
});
