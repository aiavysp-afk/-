import type { ReactNode } from "react";
import "./admin-login-page.css";

/** The public entry shell never mounts management navigation or business data. */
export function AdminLoginPage({ children }: { children: ReactNode }) {
  return (
    <main className="admin-login-page" aria-labelledby="admin-login-page-title">
      <div className="admin-login-page__content">
        <div className="admin-login-page__brand" aria-label="中原到家">
          <span className="admin-login-page__mark" aria-hidden="true">
            中
          </span>
          <div>
            <strong>中原到家</strong>
            <span>安心上门 · 悦享松弛</span>
          </div>
        </div>
        <div className="admin-login-page__intro">
          <h1 id="admin-login-page-title">管理后台</h1>
          <p>登录后进入运营工作台</p>
        </div>
        <div className="admin-login-page__panel">{children}</div>
        <p className="admin-login-page__footer">中原到家 · 运营管理系统</p>
      </div>
    </main>
  );
}
