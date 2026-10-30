import { useState } from "react";
import entryCode from "./assets/technician-wechat-entry-trial.jpg";
import "./technician-wechat-entry.css";

export const TECHNICIAN_WECHAT_ENTRY_PATH = "pages/technician-onboarding/index";
export function TechnicianWechatEntry() {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  return (
    <section
      className="technician-wechat-entry"
      aria-label="微信扫码技师入驻申请"
    >
      <span className="wechat-entry-brand">中原到家 · 技师服务中心</span>
      <h2>技师入驻直达码</h2>
      <p>将下方入驻码发给申请人。微信扫一扫后，直接填写姓名、手机号并上传一张证书照片，无需登录或注册账号。</p>
      {failed ? (
        <div className="wechat-entry-image-error" role="alert">
          <p>二维码暂未加载，请检查网络后重试。</p>
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              setRetry((value) => value + 1);
            }}
          >
            重新加载二维码
          </button>
        </div>
      ) : (
        <img
          key={retry}
          className="wechat-entry-code"
          src={`${entryCode}${retry ? `?retry=${retry}` : ""}`}
          width="258"
          height="258"
          alt="技师入驻申请体验码"
          onError={() => setFailed(true)}
        />
      )}
      <p className="wechat-entry-scan-tip">
        只扫这一个码即可；在微信里可长按识别。
      </p>
      <a className="wechat-entry-download" href={entryCode} target="_blank" rel="noreferrer">打开入驻码大图，保存后发给技师</a>
      <ol>
        <li>填写姓名和联系手机号</li>
        <li>上传一张证书照片</li>
        <li>提交管理后台审核</li>
      </ol>
      <p>提交成功后显示待审核，由管理员联系确认。此入口只收集申请，不展示技师名单，也不提供接单工作台。</p>
      <p className="wechat-entry-environment" role="status">
        当前为体验入口，仅小程序管理员及已添加的体验成员可用。业务类目准入及正式审核尚需确认，此码不代表已获准对外营业。
      </p>
    </section>
  );
}
