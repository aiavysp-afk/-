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
      aria-label="微信扫码技师入驻登录"
    >
      <span className="wechat-entry-brand">中原到家 · 技师服务中心</span>
      <h2>技师入驻直达码</h2>
      <p>将下方入驻码直接发给技师。技师用本人微信扫一扫，直接进入授权登录页，随后填写本人入驻资料。</p>
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
          alt="技师微信授权入驻体验码"
          onError={() => setFailed(true)}
        />
      )}
      <p className="wechat-entry-scan-tip">
        只扫这一个码即可；在微信里可长按识别。
      </p>
      <a className="wechat-entry-download" href={entryCode} target="_blank" rel="noreferrer">打开入驻码大图，保存后发给技师</a>
      <ol>
        <li>微信授权登录</li>
        <li>填写资料与上传照片</li>
        <li>提交管理后台审核</li>
      </ol>
      <p>再次扫码会接续本人申请；待审核显示进度，审核通过后进入技师工作台。</p>
      <p className="wechat-entry-environment" role="status">
        当前为体验入口，仅小程序管理员及已添加的体验成员可用。正式版审核发布后开放给全部技师。
      </p>
    </section>
  );
}
