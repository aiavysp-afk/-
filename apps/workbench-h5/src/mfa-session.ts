export type StaffMfaStatus = {
  enabled: boolean;
  enrollmentPending: boolean;
  lockedUntil: string | null;
  verifiedUntil: string | null;
  required: boolean;
  staffEligible: boolean;
};

export type StaffMfaEnrollment = {
  secret: string;
  expiresAt: string;
  issuer: string;
  accountName: string;
};

export type MfaSnapshot = {
  status: StaffMfaStatus | null;
  enrollment: StaffMfaEnrollment | null;
  busy: boolean;
  error: string;
};

export type MfaRequest = <T>(
  path: string,
  body: Record<string, string> | undefined,
  token: string,
) => Promise<T>;

const emptySnapshot = (): MfaSnapshot => ({
  status: null,
  enrollment: null,
  busy: false,
  error: "",
});
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "安全验证暂不可用，请重试";
const unauthorized = (error: unknown) =>
  (error as { status?: number } | null)?.status === 401;

// A one-time enrollment secret never leaves this in-memory session boundary.
export class MfaSession {
  private token = "";
  private generation = 0;
  private operation = 0;
  private snapshot = emptySnapshot();
  private listeners = new Set<() => void>();

  constructor(
    private request: MfaRequest,
    private onSessionExpired: (token: string) => void,
    private now = () => Date.now(),
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(next: MfaSnapshot) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  setToken(token: string) {
    if (this.token === token) return;
    this.token = token;
    this.generation++;
    this.operation++;
    this.publish(emptySnapshot());
    if (token) void this.refresh();
  }

  clearIfToken(token: string) {
    if (this.token === token) this.setToken("");
  }

  isReady(token: string) {
    const status = this.snapshot.status;
    return Boolean(
      token &&
        token === this.token &&
        !this.snapshot.busy &&
        status?.staffEligible === true &&
        (status.required === false ||
          (status.required === true &&
            status.enabled === true &&
            Date.parse(status.verifiedUntil ?? "") > this.now())),
    );
  }

  // Capture before starting any private request; recheck after every await.
  guard(token: string, requireReady = false) {
    const generation = this.generation;
    return () =>
      generation === this.generation &&
      token === this.token &&
      (!requireReady || this.isReady(token));
  }

  expire(token: string) {
    if (!token || this.token !== token) return;
    this.generation++;
    this.operation++;
    this.publish({
      ...this.snapshot,
      busy: false,
      enrollment: null,
      status: this.snapshot.status
        ? { ...this.snapshot.status, verifiedUntil: null }
        : null,
      error: "本次安全验证已到期，请重新输入动态码",
    });
  }

  expireEnrollment(token: string) {
    const enrollment = this.snapshot.enrollment;
    if (
      token !== this.token ||
      !enrollment ||
      Date.parse(enrollment.expiresAt) > this.now()
    )
      return;
    this.generation++;
    this.operation++;
    this.publish({
      ...this.snapshot,
      busy: false,
      enrollment: null,
      error: "绑定密钥已过期，请刷新安全状态后重新发起",
    });
  }

  private begin() {
    // Always retire private requests, even if time expired before the UI timer ran.
    this.generation++;
    const token = this.token;
    const generation = this.generation;
    const operation = ++this.operation;
    this.publish({ ...this.snapshot, busy: true, error: "" });
    return {
      token,
      current: () =>
        token === this.token &&
        generation === this.generation &&
        operation === this.operation,
    };
  }

  private async readStatus(token: string, current: () => boolean) {
    const status = await this.request<StaffMfaStatus>(
      "/auth/mfa",
      undefined,
      token,
    );
    if (!current()) return;
    const enrollment = this.snapshot.enrollment;
    this.publish({
      ...this.snapshot,
      status,
      enrollment:
        status.enabled ||
        !status.enrollmentPending ||
        (enrollment && Date.parse(enrollment.expiresAt) <= this.now())
          ? null
          : enrollment,
    });
  }

  private endSession(token: string) {
    this.setToken("");
    this.onSessionExpired(token);
  }

  async refresh() {
    if (!this.token || this.snapshot.busy) return;
    const { token, current } = this.begin();
    try {
      await this.readStatus(token, current);
    } catch (error) {
      if (!current()) return;
      if (unauthorized(error)) {
        this.endSession(token);
        return;
      }
      this.publish({
        ...this.snapshot,
        status: null,
        error: errorMessage(error),
      });
    } finally {
      if (current()) this.publish({ ...this.snapshot, busy: false });
    }
  }

  async recheckAfterForbidden(token: string) {
    if (token !== this.token || this.snapshot.busy) return;
    const current = this.guard(token);
    const operation = this.operation;
    try {
      const status = await this.request<StaffMfaStatus>(
        "/auth/mfa",
        undefined,
        token,
      );
      if (!current() || operation !== this.operation) return;
      // A role-related 403 must not create an automatic verification/reload loop.
      if (
        status.staffEligible !== true ||
        (status.required !== false &&
          (status.enabled !== true ||
            !(Date.parse(status.verifiedUntil ?? "") > this.now())))
      ) {
        this.expire(token);
        this.publish({ ...this.snapshot, status });
      }
    } catch (error) {
      if (!current() || operation !== this.operation) return;
      if (unauthorized(error)) {
        this.endSession(token);
        return;
      }
      this.expire(token);
      this.publish({
        ...this.snapshot,
        status: null,
        error: errorMessage(error),
      });
    }
  }

  async enroll() {
    const status = this.snapshot.status;
    if (
      !this.token ||
      this.snapshot.busy ||
      !status?.staffEligible ||
      status.enabled ||
      status.enrollmentPending
    )
      return;
    await this.mutate("/auth/mfa/enrollment", {});
  }

  async verify(code: string) {
    const status = this.snapshot.status;
    if (!this.token || this.snapshot.busy || !status?.staffEligible) return;
    if (!/^\d{6}$/.test(code)) {
      this.publish({
        ...this.snapshot,
        error: "请输入认证器中的六位数字动态码",
      });
      return;
    }
    // Global pending status cannot prove that this session owns the enrollment.
    if (
      !status.enabled &&
      (!this.snapshot.enrollment ||
        !(Date.parse(this.snapshot.enrollment.expiresAt) > this.now()))
    ) {
      this.publish({
        ...this.snapshot,
        enrollment: null,
        error: "本页没有有效的绑定密钥，请等待原绑定过期后重新发起",
      });
      return;
    }
    if (Date.parse(status.lockedUntil ?? "") > this.now()) {
      this.publish({
        ...this.snapshot,
        error: "动态码暂时锁定，请等待锁定结束后重试",
      });
      return;
    }
    await this.mutate(
      status.enabled ? "/auth/mfa/verify" : "/auth/mfa/activate",
      { code },
    );
  }

  private async mutate(path: string, body: Record<string, string>) {
    const { token, current } = this.begin();
    try {
      const result = await this.request<
        StaffMfaEnrollment | { verifiedUntil: string }
      >(path, body, token);
      if (!current()) return;
      this.publish({
        ...this.snapshot,
        enrollment: path.endsWith("/enrollment")
          ? (result as StaffMfaEnrollment)
          : null,
      });
    } catch (error) {
      if (!current()) return;
      // OTP, old login and another session's enrollment all use 401 as well.
      this.publish({ ...this.snapshot, error: errorMessage(error) });
    }
    if (!current()) return;
    try {
      await this.readStatus(token, current);
    } catch (error) {
      if (!current()) return;
      if (unauthorized(error)) {
        this.endSession(token);
        return;
      }
      this.publish({
        ...this.snapshot,
        status: null,
        error: errorMessage(error),
      });
    } finally {
      if (current()) this.publish({ ...this.snapshot, busy: false });
    }
  }
}
