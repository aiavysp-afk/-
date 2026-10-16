import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SchedulingWorkspace } from "./admin-resources";

describe("scheduling read state", () => {
  it("does not label an unread day as successfully empty", () => {
    const html = renderToStaticMarkup(
      <SchedulingWorkspace
        token="test-session"
        organizationId="organization-a"
        login={async () => {}}
      />,
    );
    expect(html).toContain("正在读取当日排班");
    expect(html).not.toContain("当日暂无排班");
  });

  it("does not expose a date or shift form before an authorized identity exists", () => {
    const html = renderToStaticMarkup(
      <SchedulingWorkspace
        token=""
        organizationId="organization-a"
        login={async () => {}}
      />,
    );
    expect(html).toContain("当前页面需要授权身份");
    expect(html).not.toContain("创建有效排班");
    expect(html).not.toContain("当日暂无排班");
  });
});
