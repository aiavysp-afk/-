import { safeFriendPaymentReturnPath } from "./friend-payment";

export function safeLoginReturnPath(value?: string) {
  let decoded = value;
  try {
    if (value) decoded = decodeURIComponent(value);
  } catch {
    return "";
  }
  return decoded === "/pages/technician-onboarding/index" ||
    decoded === "/pages/technician-workbench/index" ||
    decoded === "/pages/admin-login/index"
    ? decoded
    : safeFriendPaymentReturnPath(value);
}
