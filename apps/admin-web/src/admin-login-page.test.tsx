import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminLoginPage } from "./admin-login-page";
import { BrowserLogin } from "./browser-login";

describe("standalone administrator entry page", () => {
  it("contains the account login without workbench navigation or an alternate scan flow", () => {
    const html = renderToStaticMarkup(
      <AdminLoginPage>
        <BrowserLogin onSession={() => {}} />
      </AdminLoginPage>,
    );
    expect(html).toContain('<main class="admin-login-page"');
    expect(html).toContain('aria-labelledby="admin-login-page-title"');
    expect(html).toContain("中原到家");
    expect(html).toContain("账号密码登录");
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("订单调度");
    expect(html).not.toContain("技师管理");
    expect(html).not.toContain("扫码");
  });

  it("can show a session check status without mounting another login form", () => {
    const html = renderToStaticMarkup(
      <AdminLoginPage>
        <p role="status">正在验证登录状态…</p>
      </AdminLoginPage>,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("正在验证登录状态…");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<nav");
  });
});
