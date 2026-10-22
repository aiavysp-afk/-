import type { H5OnboardingStatus } from "./h5-onboarding";
import {
  phoneOnboardingPaths,
  phoneWorkbenchAllowed,
  type TechnicianPhoneCapabilities,
} from "./phone-onboarding";

type Request = <T>(path: string, token: string) => Promise<T>;
export type PhoneWorkbenchSnapshot = {
  busy: boolean;
  ready: boolean;
  error: string;
};

// Independent readiness proof, not an MFA exception fabricated in MfaSession.
// Every workbench request remains subject to the server's phone-source guard.
export class PhoneWorkbenchSession {
  private token = "";
  private generation = 0;
  private snapshot: PhoneWorkbenchSnapshot = {
    busy: false,
    ready: false,
    error: "",
  };
  private listeners = new Set<() => void>();
  constructor(
    private request: Request,
    private onExpired: (token: string) => void,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: PhoneWorkbenchSnapshot) {
    this.snapshot = value;
    this.listeners.forEach((listener) => listener());
  }
  setToken(token: string) {
    if (this.token === token) return;
    this.token = token;
    this.generation++;
    this.publish({ busy: false, ready: false, error: "" });
    if (token) void this.refresh();
  }
  clearIfToken(token: string) {
    if (token === this.token) this.setToken("");
  }
  isReady(token: string) {
    return Boolean(
      token &&
        token === this.token &&
        this.snapshot.ready &&
        !this.snapshot.busy,
    );
  }
  guard(token: string, ready = false) {
    const generation = this.generation;
    return () =>
      generation === this.generation &&
      token === this.token &&
      (!ready || this.isReady(token));
  }
  async refresh() {
    if (!this.token || this.snapshot.busy) return;
    const token = this.token;
    const generation = ++this.generation;
    const current = () =>
      generation === this.generation && token === this.token;
    this.publish({ busy: true, ready: false, error: "" });
    try {
      const paths = phoneOnboardingPaths();
      const [capabilities, status] = await Promise.all([
        this.request<TechnicianPhoneCapabilities>(paths.capabilities, ""),
        this.request<H5OnboardingStatus>(paths.status, token),
      ]);
      if (!current()) return;
      const ready = phoneWorkbenchAllowed(capabilities, status);
      this.publish({
        busy: false,
        ready,
        error: ready
          ? ""
          : "当前账号尚未审核通过，或网页工作台尚未开通。请返回入驻页查看进度。",
      });
    } catch (error) {
      if (!current()) return;
      if ([401, 403].includes((error as { status?: number })?.status ?? 0)) {
        this.setToken("");
        this.onExpired(token);
        return;
      }
      this.publish({
        busy: false,
        ready: false,
        error:
          error instanceof Error ? error.message : "工作台资格校验失败，请重试",
      });
    }
  }
  // A denied business request immediately retires all in-flight data, with no auto reload loop.
  async recheckAfterForbidden(token: string) {
    if (token !== this.token) return;
    this.generation++;
    this.publish({
      busy: false,
      ready: false,
      error: "当前权限已变化，请返回入驻页重新验证本人手机号。",
    });
    this.onExpired(token);
  }
}
