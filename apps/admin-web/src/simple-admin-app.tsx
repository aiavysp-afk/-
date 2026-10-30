import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AuthSession, AuthUser } from "@zydj/contracts";
import { AdminLoginPage } from "./admin-login-page";
import { BrowserLogin } from "./browser-login";
import {
  authenticatedFetch,
  registerAdminSession,
} from "./authenticated-fetch";
import { managementOrganizationId } from "./login-state";
import { SimpleVerificationDialog } from "./simple-verification-dialog";
import {
  SimpleOrdersPage,
  SimpleTechniciansPage,
  SimpleUsersPage,
} from "./simple-admin-pages";
import "./styles.css";
import "./simple-admin-shell.css";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const TOKEN_STORAGE_KEY = "zydj.admin.access-token";
const pages = [
  { id: "technicians", label: "技师审核" },
  { id: "orders", label: "订单列表" },
  { id: "users", label: "用户列表" },
] as const;
type Section = (typeof pages)[number]["id"];
function initialSection(): Section {
  const hash =
    typeof window === "undefined" ? "" : window.location.hash.slice(1);
  return pages.find((page) => page.id === hash)?.id ?? "technicians";
}
async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const response = await authenticatedFetch(token, `${API_BASE_URL}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    ...options,
    headers: {
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      Error(body.message ?? `请求失败（${response.status}）`),
      { status: response.status },
    );
  return body as T;
}
export function App() {
  const [section, setSection] = useState<Section>(initialSection);
  const [token, setToken] = useState(
    () => sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [verifiedToken, setVerifiedToken] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [sessionCheckAttempt, setSessionCheckAttempt] = useState(0);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const currentToken = useRef(token);
  currentToken.current = token;
  const clearSession = useCallback((expiredToken: string) => {
    if (currentToken.current !== expiredToken) return;
    currentToken.current = "";
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken("");
    setUser(null);
    setOrganizationId("");
    setVerifiedToken("");
    setSessionError("");
    setVerificationOpen(false);
    setSection("technicians");
  }, []);
  useLayoutEffect(
    () =>
      registerAdminSession(
        token,
        () => clearSession(token),
        () => currentToken.current === token,
      ),
    [token, clearSession],
  );
  useEffect(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    if (!token) {
      setUser(null);
      return;
    }
    setSessionError("");
    let current = true;
    void apiRequest<{ data: AuthUser }>("/auth/me", {}, token)
      .then(({ data }) => {
        if (!current || currentToken.current !== token) return;
        setUser(data);
        setOrganizationId(managementOrganizationId(data));
        setVerifiedToken(token);
      })
      .catch((error: { status?: number }) => {
        if (!current || currentToken.current !== token) return;
        if (error.status === 401) clearSession(token);
        else setSessionError("登录状态暂时无法验证，请检查网络后重试。");
      });
    return () => {
      current = false;
    };
  }, [token, clearSession, sessionCheckAttempt]);
  const authenticated = Boolean(
    token && verifiedToken === token && user && organizationId,
  );
  useEffect(() => {
    const onHashChange = () => {
      if (!verificationOpen) setSection(initialSection());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [verificationOpen]);
  useLayoutEffect(() => {
    const destination = !token
      ? "/login"
      : authenticated
        ? `/#${section}`
        : null;
    if (
      destination &&
      `${window.location.pathname}${window.location.search}${window.location.hash}` !==
        destination
    )
      window.history.replaceState(null, "", destination);
    document.title = authenticated
      ? `中原到家 · ${pages.find((page) => page.id === section)!.label}`
      : "中原到家 · 管理后台登录";
  }, [token, authenticated, section]);
  function acceptBrowserSession(session: AuthSession) {
    if (currentToken.current) {
      void apiRequest(
        "/auth/logout",
        { method: "POST", body: "{}" },
        session.accessToken,
      ).catch(() => {});
      return;
    }
    sessionStorage.setItem(TOKEN_STORAGE_KEY, session.accessToken);
    currentToken.current = session.accessToken;
    setToken(session.accessToken);
    setUser(session.user);
    setOrganizationId(managementOrganizationId(session.user));
    setVerifiedToken(session.accessToken);
    setSessionError("");
    setVerificationOpen(false);
    setSection("technicians");
  }
  async function requestLogout() {
    const requestedToken = token;
    try {
      await apiRequest(
        "/auth/logout",
        { method: "POST", body: "{}" },
        requestedToken,
      );
      clearSession(requestedToken);
    } catch (error) {
      if (currentToken.current !== requestedToken) return;
      if ((error as { status?: number }).status === 401)
        clearSession(requestedToken);
      else setSessionError("退出暂未完成，请检查网络后重试。");
    }
  }
  if (!token)
    return (
      <AdminLoginPage>
        <BrowserLogin onSession={acceptBrowserSession} />
      </AdminLoginPage>
    );
  if (!authenticated) {
    const staffDenied = verifiedToken === token && user && !organizationId;
    return (
      <AdminLoginPage>
        <section className="admin-session-check" aria-label="登录状态验证">
          {staffDenied ? (
            <p role="alert">当前账号没有后台管理权限，请联系管理员。</p>
          ) : sessionError ? (
            <>
              <p role="alert">{sessionError}</p>
              <button
                className="primary-action"
                onClick={() => {
                  setSessionError("");
                  setSessionCheckAttempt((attempt) => attempt + 1);
                }}
              >
                重新验证登录状态
              </button>
            </>
          ) : (
            <p role="status">正在验证登录状态，请稍候…</p>
          )}
          <button
            className="ghost-action"
            aria-label="退出当前后台账号"
            onClick={() => void requestLogout()}
          >
            退出并返回登录页
          </button>
        </section>
      </AdminLoginPage>
    );
  }
  const pageProps = {
    token,
    organizationId,
    hideActions: verificationOpen,
    onRequireVerification: () => setVerificationOpen(true),
  };
  return (
    <div className="simple-admin-shell">
      <aside
        className="simple-admin-nav"
        aria-label="管理后台导航"
        inert={verificationOpen || undefined}
        aria-hidden={verificationOpen || undefined}
      >
        <div className="simple-admin-brand">
          中原到家<small>管理后台</small>
        </div>
        <nav aria-label="三个管理页面">
          {pages.map((page) => (
            <a
              key={page.id}
              href={`#${page.id}`}
              aria-current={section === page.id ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (!verificationOpen) setSection(page.id);
              }}
            >
              {page.label}
            </a>
          ))}
        </nav>
        <div className="simple-admin-account">
          <span>{user?.displayName}</span>
          <a
            href="/login"
            aria-label="退出当前后台账号"
            onClick={(event) => {
              event.preventDefault();
              void requestLogout();
            }}
          >
            退出登录
          </a>
        </div>
      </aside>
      <main className="simple-admin-main">
        <header className="simple-admin-heading">
          <h1>{pages.find((page) => page.id === section)!.label}</h1>
          <span>已登录</span>
        </header>
        {sessionError && (
          <p role="alert" className="catalog-error">
            {sessionError}
          </p>
        )}
        <div
          aria-hidden={verificationOpen || undefined}
          inert={verificationOpen || undefined}
        >
          {section === "technicians" ? (
            <SimpleTechniciansPage
              key={`${token}:${organizationId}`}
              {...pageProps}
            />
          ) : section === "orders" ? (
            <SimpleOrdersPage
              key={`${token}:${organizationId}`}
              {...pageProps}
            />
          ) : (
            <SimpleUsersPage
              key={`${token}:${organizationId}`}
              {...pageProps}
            />
          )}
        </div>
      </main>
      {verificationOpen && (
        <SimpleVerificationDialog
          key={token}
          token={token}
          onClose={() => setVerificationOpen(false)}
        />
      )}
    </div>
  );
}
