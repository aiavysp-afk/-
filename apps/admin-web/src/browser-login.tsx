import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "@zydj/contracts";
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
type Pair = {
  pairCode: string;
  browserSecret: string;
  confirmationCode: string;
  expiresAt: string;
};
export function BrowserLogin({
  onSession,
}: {
  onSession: (session: AuthSession) => void;
}) {
  const [config, setConfig] = useState<{
    enabled: boolean;
    provider: string;
  } | null>(null);
  const [pair, setPair] = useState<Pair | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    currentPair = useRef<Pair | null>(null);
  currentPair.current = pair;
  async function request<T>(path: string, body?: unknown) {
    const r = await fetch(`${API_BASE_URL}/auth/browser-login/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await r.json();
    if (!r.ok)
      throw Error(
        typeof json.message === "string" ? json.message : "登录请求失败",
      );
    return json.data as T;
  }
  const proof = (p: Pair) => ({
    pairCode: p.pairCode,
    browserSecret: p.browserSecret,
  });
  async function revoke(session: AuthSession) {
    await fetch(`${API_BASE_URL}/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: "{}",
    }).catch(() => {});
  }
  useEffect(() => {
    let active = true;
    void request<{ enabled: boolean; provider: string }>("config")
      .then((x) => {
        if (active) setConfig(x);
      })
      .catch(() => {
        if (active) setError("登录配置暂时不可读");
      });
    return () => {
      active = false;
      generation.current++;
      const p = currentPair.current;
      if (p) void request("cancel", proof(p)).catch(() => {});
    };
  }, []);
  async function start() {
    if (busy || pair) return;
    const id = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const p = await request<Pair>("create", {});
      if (id === generation.current) setPair(p);
      else void request("cancel", proof(p)).catch(() => {});
    } catch (e) {
      if (id === generation.current)
        setError(e instanceof Error ? e.message : "发起失败");
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }
  async function check() {
    if (busy || !pair) return;
    const id = generation.current,
      p = pair;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ status: string }>("poll", proof(p));
      if (id !== generation.current) return;
      if (result.status !== "APPROVED") {
        setError(
          result.status === "PENDING"
            ? "尚待小程序确认；请至少间隔两秒检查。"
            : "本次配对已结束，请取消后重新发起。",
        );
        return;
      }
      // Claim only once. A lost response requires a new pair, never mint a second session.
      const session = await request<AuthSession>("claim", proof(p));
      if (id !== generation.current) {
        await revoke(session);
        return;
      }
      currentPair.current = null;
      setPair(null);
      onSession(session);
    } catch (e) {
      if (id === generation.current)
        setError(e instanceof Error ? e.message : "登录未确认，请重新发起配对");
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!pair || busy) return;
    const p = pair;
    ++generation.current;
    setBusy(true);
    setError("");
    try {
      await request("cancel", proof(p));
      setPair(null);
      currentPair.current = null;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "取消失败；请等待配对三分钟到期",
      );
      if (Date.parse(p.expiresAt) <= Date.now()) {
        setPair(null);
        currentPair.current = null;
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="catalog-workspace">
      <div className="catalog-gate">
        <div>
          <strong>微信小程序确认后台登录</strong>
          <p>
            只在自己打开的电脑上发起。小程序完成微信身份核验后，电脑还须独立完成
            MFA。
          </p>
        </div>
      </div>
      {config?.provider === "mock" && (
        <div className="catalog-error">
          当前为隔离 Mock 验收，不是真实微信登录；不得用于正式经营。
        </div>
      )}
      {error && (
        <div className="catalog-error" role="alert">
          {error}
        </div>
      )}
      {!config?.enabled ? (
        <p>登录交接尚未开放，请等待管理员完成受控配置和验收。</p>
      ) : !pair ? (
        <button
          className="primary-action"
          disabled={busy}
          onClick={() => void start()}
        >
          发起微信后台登录
        </button>
      ) : (
        <div className="panel" style={{ padding: 24 }}>
          <p>打开中原到家小程序 → 我的 → 后台登录确认，手动输入以下配对码：</p>
          <code style={{ fontSize: 20, overflowWrap: "anywhere" }}>
            {pair.pairCode}
          </code>
          <p>
            在小程序输入这六位核对数字：<strong>{pair.confirmationCode}</strong>
          </p>
          <p>
            三分钟内有效，到期时间：
            {new Date(pair.expiresAt).toLocaleTimeString("zh-CN")}
          </p>
          <p>
            不要接受他人发来的配对码，不向客服或在线网站提供令牌、密钥或动态码。
          </p>
          <div className="catalog-actions">
            <button
              className="primary-action"
              disabled={busy}
              onClick={() => void check()}
            >
              我已在小程序确认
            </button>
            <button
              className="ghost-action"
              disabled={busy}
              onClick={() => void cancel()}
            >
              取消本次登录
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
