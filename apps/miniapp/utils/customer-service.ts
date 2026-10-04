import type { PublicConfig } from "@zydj/contracts";

type Contact = PublicConfig["customerService"];
export type CustomerServiceDiagnostic = {
  stage: "CONFIG" | "CLIENT" | "SDK_CALLBACK" | "SDK_THROW";
  code: string;
  signal: string;
};

function failureDiagnostic(
  error: unknown,
  stage: CustomerServiceDiagnostic["stage"],
): CustomerServiceDiagnostic {
  // Never forward the provider object or raw text: it may contain identifiers/URLs/secrets.
  let code = "NOT_PROVIDED";
  let message = "";
  try {
    if (error && typeof error === "object") {
      const value = error as { errCode?: unknown; errMsg?: unknown };
      const numeric = value.errCode;
      if (
        (typeof numeric === "number" &&
          Number.isInteger(numeric) &&
          Math.abs(numeric) <= 999999999) ||
        (typeof numeric === "string" && /^-?\d{1,9}$/.test(numeric))
      )
        code = String(Number(numeric));
      if (typeof value.errMsg === "string" && value.errMsg.length <= 512) {
        const match = value.errMsg
          .toLowerCase()
          .match(/^opencustomerservicechat:fail\s+(.+)$/);
        if (match?.[1]) message = match[1].trim();
      }
    }
  } catch {
    // Malformed SDK values must not prevent the emergency fallback.
    code = "NOT_PROVIDED";
    message = "";
  }
  // No number extraction from arbitrary text: a URL/token may look like an error code.
  // These are wording clues, NOT an official mapping or a confirmed root cause.
  let signal = "UNKNOWN";
  if (
    // The native DevTools wording may include the fixed API word, never arbitrary ASCII.
    /^[\u3400-\u9fff\s，。；：、（）！？,.!?:;()]+$/.test(
      message.replace(/\bapi\b/g, ""),
    ) &&
    message.includes("开发者工具") &&
    message.includes("不支持") &&
    message.includes("真机")
  )
    signal = "DEVTOOLS_UNSUPPORTED_WORDING";
  else if (/^(?:not support(?:ed)?|unsupported)\.?$/.test(message))
    signal = "UNSUPPORTED_WORDING";
  else if (
    /^(?:permission denied|permission deny|no permission|not authorized|unauthorized)\.?$/.test(
      message,
    )
  )
    signal = "PERMISSION_WORDING";
  else if (
    /^(?:user tap|user gesture|user click)(?: required)?\.?$/.test(message)
  )
    signal = "GESTURE_WORDING";
  else if (
    /^(?:invalid (?:parameter|param|corpid|url|extinfo)|parameter error)\.?$/.test(
      message,
    )
  )
    signal = "ARGUMENT_WORDING";
  else if (/^(?:cancel|canceled|cancelled)\.?$/.test(message))
    signal = "CANCEL_WORDING";
  else if (
    /^(?:network(?: error| timeout)?|timeout|time out)\.?$/.test(message)
  )
    signal = "NETWORK_WORDING";
  return { stage, code, signal };
}

export function openWecomCustomerService(
  contact: Contact,
  host = wx,
  onFailure?: (diagnostic: CustomerServiceDiagnostic) => void | boolean,
) {
  const report = (diagnostic: CustomerServiceDiagnostic) => {
    try {
      // Only an explicit false discards a superseded attempt, including its old toast.
      return onFailure?.(diagnostic) !== false;
    } catch {
      /* Diagnostic UI cannot suppress the fallback. */
      return true;
    }
  };
  // Synchronous tap handler: no network await before invoking the native user-gesture API.
  if (
    !contact?.available ||
    contact.provider !== "wecom" ||
    !/^ww[A-Za-z0-9]{16}$/.test(contact.corpId) ||
    !/^https:\/\/work\.weixin\.qq\.com\/(?:kfid|kf)\/[A-Za-z0-9_-]{5,128}(?:\?enc_scene=[A-Za-z0-9%_=-]{1,256})?$/.test(
      contact.url,
    )
  ) {
    report({
      stage: "CONFIG",
      code: "NOT_PROVIDED",
      signal: "CONTACT_UNAVAILABLE",
    });
    host.showToast({
      title: "企业微信客服未就绪，紧急情况请立即求助",
      icon: "none",
    });
    return;
  }
  if (typeof host.openCustomerServiceChat !== "function") {
    report({
      stage: "CLIENT",
      code: "NOT_PROVIDED",
      signal: "API_UNAVAILABLE",
    });
    host.showToast({ title: "当前微信版本不支持，请升级后重试", icon: "none" });
    return;
  }
  const showFailure = (
    error: unknown,
    stage: CustomerServiceDiagnostic["stage"],
  ) => {
    const diagnostic = failureDiagnostic(error, stage);
    if (!report(diagnostic)) return;
    host.showToast({
      title:
        diagnostic.signal === "DEVTOOLS_UNSUPPORTED_WORDING"
          ? "开发者工具模拟器不支持客服，请使用微信真机"
          : "客服入口未打开，请重试；紧急情况请立即求助",
      icon: "none",
    });
  };
  try {
    host.openCustomerServiceChat({
      corpId: contact.corpId,
      extInfo: { url: contact.url },
      fail: (error: unknown) => showFailure(error, "SDK_CALLBACK"),
    });
  } catch (error) {
    showFailure(error, "SDK_THROW");
  }
}

export function callEmergencyDuty(
  contact: PublicConfig["emergencyContact"],
  host = wx,
) {
  if (!contact?.configured || !/^1[3-9]\d{9}$/.test(contact.phone)) {
    host.showToast({
      title: "商家紧急值班电话未配置，请立即寻求其他帮助",
      icon: "none",
    });
    return;
  }
  host.makePhoneCall({
    phoneNumber: contact.phone,
    fail: () =>
      host.showToast({
        title: "拨号未完成，请手动拨号或寻求其他帮助",
        icon: "none",
      }),
  });
}
