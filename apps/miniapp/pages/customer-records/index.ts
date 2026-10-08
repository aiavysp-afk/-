import type { CustomerFeedback, CustomerFeedbackCreate } from "@zydj/contracts";
import { api, newKey } from "../../utils/api";
import { requireVerifiedCustomerAccess } from "../../utils/auth";
import {
  getCustomerCenterOrganizationId,
  loadCustomerCenterOverview,
} from "../../utils/customer-center";

type RecordKind =
  | "favorites"
  | "history"
  | "complaint"
  | "feedback"
  | "about"
  | "news";

const pageTitles: Record<RecordKind, string> = {
  favorites: "我的收藏",
  history: "浏览足迹",
  complaint: "投诉与售后",
  feedback: "意见反馈",
  about: "关于我们",
  news: "城市快讯",
};

Page({
  data: {
    kind: "favorites" as RecordKind,
    title: "我的收藏",
    content: "",
    contact: "",
    busy: false,
    error: "",
    newsTitle: "城市快讯",
    newsContent: "中原到家持续为郑州用户提供规范上门服务",
  },
  back() {
    wx.navigateBack({ delta: 1 });
  },
  onLoad(options: { kind?: string }) {
    const requested = options.kind as RecordKind;
    const kind = pageTitles[requested] ? requested : "favorites";
    this.setData({ kind, title: pageTitles[kind] });
    if (kind === "news") void this.loadNews();
  },
  onShow() {
    requireVerifiedCustomerAccess();
  },
  async loadNews() {
    try {
      const overview = await loadCustomerCenterOverview();
      this.setData({
        newsTitle: overview.content.cityNewsTitle,
        newsContent: overview.content.cityNewsContent,
      });
    } catch {
      // A brand-safe local message remains visible while the API is unavailable.
    }
  },
  contentChanged(event: { detail: { value: string } }) {
    this.setData({ content: event.detail.value, error: "" });
  },
  contactChanged(event: { detail: { value: string } }) {
    this.setData({ contact: event.detail.value, error: "" });
  },
  async submit() {
    if (this.data.busy) return;
    const content = this.data.content.trim();
    const contact = this.data.contact.trim();
    if (content.length < 10) {
      this.setData({ error: "请至少填写 10 个字，便于后台核实处理" });
      return;
    }
    if (contact && contact.length < 3) {
      this.setData({ error: "请填写有效联系方式，或将联系方式留空" });
      return;
    }
    const organizationId = getCustomerCenterOrganizationId();
    const payload: CustomerFeedbackCreate = {
      ...(organizationId ? { organizationId } : {}),
      category: this.data.kind === "complaint" ? "COMPLAINT" : "GENERAL",
      content,
      ...(contact ? { contact } : {}),
    };
    this.setData({ busy: true, error: "" });
    try {
      await api<CustomerFeedback>(
        "/customer-center/feedback",
        "POST",
        payload,
        newKey(),
      );
      this.setData({ content: "", contact: "" });
      wx.showModal({
        title: this.data.kind === "complaint" ? "投诉已提交" : "反馈已提交",
        content:
          "后台已收到并生成可追踪记录。提交不等于问题已经解决，涉及订单或人身安全时请同时联系在线客服或紧急服务。",
        showCancel: false,
      });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "提交失败，请稍后重试",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  goServices() {
    wx.switchTab({ url: "/pages/services/index" });
  },
  goOrders() {
    wx.navigateTo({ url: "/pages/orders/index" });
  },
});
