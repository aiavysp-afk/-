import { describe, expect, it, vi } from "vitest";
import { dialEmergencyDuty, emergencyPhoneFromConfig } from "./support";
describe("merchant emergency dialer", () => {
  it("only accepts a configured, valid number from the public config response", () => {
    expect(
      emergencyPhoneFromConfig({
        data: { emergencyContact: { configured: true, phone: "13800138000" } },
      }),
    ).toBe("13800138000");
    for (const value of [
      null,
      {},
      {
        data: { emergencyContact: { configured: false, phone: "13800138000" } },
      },
      {
        data: {
          emergencyContact: { configured: true, phone: "javascript:alert(1)" },
        },
      },
    ])
      expect(emergencyPhoneFromConfig(value)).toBe("");
  });
  it("does not navigate with absent/untrusted numbers", () => {
    const navigate = vi.fn(),
      notify = vi.fn();
    dialEmergencyDuty("", navigate, notify);
    expect(navigate).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
  });
  it("opens only a tel URI and never announces acceptance", () => {
    const navigate = vi.fn(),
      notify = vi.fn();
    dialEmergencyDuty("13800138000", navigate, notify);
    expect(navigate).toHaveBeenCalledWith("tel:13800138000");
    expect(notify).not.toHaveBeenCalled();
  });
});
