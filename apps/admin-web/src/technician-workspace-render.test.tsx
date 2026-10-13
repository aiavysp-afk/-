import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TechniciansWorkspace } from "./admin-resources";

describe("technician queue initial rendering", () => {
  it("shows a read-in-progress instead of claiming the real queue is empty", () => {
    const html = renderToStaticMarkup(
      <TechniciansWorkspace
        token="test-session"
        organizationId="organization-a"
        query=""
        login={async () => {}}
      />,
    );
    expect(html).toContain("正在读取入驻申请");
    expect(html).not.toContain("暂无自主入驻申请");
    expect(html).not.toContain("尚未生成真实技师邀请");
    expect(html).not.toContain("当前组织暂无已启用技师");
  });

  it("does not display queue data or a misleading empty state without a session", () => {
    const html = renderToStaticMarkup(
      <TechniciansWorkspace
        token=""
        organizationId="organization-a"
        query=""
        login={async () => {}}
      />,
    );
    expect(html).toContain("当前页面需要授权身份");
    expect(html).not.toContain("微信自主入驻审核");
    expect(html).not.toContain("暂无自主入驻申请");
  });
});
