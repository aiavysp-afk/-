import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  TechnicianWechatEntry,
  TECHNICIAN_WECHAT_ENTRY_PATH,
} from "./technician-wechat-entry";
import { readFileSync } from "node:fs";
describe("technician native WeChat entry", () => {
  it("offers a direct native entry without pretending a QR scan authenticates the web browser", () => {
    const html = renderToStaticMarkup(<TechnicianWechatEntry />);
    expect(TECHNICIAN_WECHAT_ENTRY_PATH).toBe(
      "pages/technician-onboarding/index",
    );
    expect(html).toContain("技师入驻直达码");
    expect(html).toContain("technician-wechat-entry-trial.jpg");
    expect(html).toContain("无需登录或注册账号");
    expect(html).toContain("一张证书照片");
    expect(html).not.toContain("直接进入授权登录页");
    expect(html).not.toContain("审核通过后进入技师工作台");
    expect(html).toContain("只扫这一个码即可");
    expect(html).toContain("仅小程序管理员及已添加的体验成员可用");
    expect(html).not.toContain("浏览器自动登录");
    expect(html).not.toContain("配对码");
    expect(html).not.toContain('type="password"');
  });
  it("packages the official entry code and prioritizes WeChat without removing SMS recovery", () => {
    const image = readFileSync(
      new URL("./assets/technician-wechat-entry-trial.jpg", import.meta.url),
    );
    expect(image.length).toBeGreaterThan(1000);
    expect(image.subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    const source = readFileSync(
      new URL("./phone-onboarding-page.tsx", import.meta.url),
      "utf8",
    );
    expect(source.indexOf("<TechnicianWechatEntry />")).toBeLessThan(
      source.indexOf('<details className="technician-sms-alternative">'),
    );
    expect(source).toContain("其他登录方式：手机号验证码");
  });
});
