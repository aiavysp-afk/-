import type { CustomerCoupon, CustomerCouponStatus } from "@zydj/contracts";
import { api, money } from "../../utils/api";
import { customerCenterPath } from "../../utils/customer-center";
import { requireVerifiedCustomerAccess } from "../../utils/auth";

type CouponRow = CustomerCoupon & {
  amount: string;
  threshold: string;
  validity: string;
  statusLabel: string;
};

const statusLabels: Record<CustomerCouponStatus, string> = {
  AVAILABLE: "可使用",
  USED: "已使用",
  EXPIRED: "已过期",
};

Page({
  data: {
    tabs: [
      { key: "AVAILABLE", label: "可用优惠券" },
      { key: "USED", label: "已使用" },
      { key: "EXPIRED", label: "已过期" },
    ],
    activeStatus: "AVAILABLE" as CustomerCouponStatus,
    coupons: [] as CouponRow[],
    loading: false,
    error: "",
  },
  back() {
    wx.navigateBack({ delta: 1 });
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
    await this.load();
  },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const coupons = await api<CustomerCoupon[]>(
        customerCenterPath("/customer-center/coupons", {
          status: this.data.activeStatus,
        }),
      );
      this.setData({
        coupons: coupons.map((coupon) => ({
          ...coupon,
          amount: money(coupon.amountFen),
          threshold:
            coupon.minimumSpendFen > 0
              ? `项目费满 ¥${money(coupon.minimumSpendFen)} 可用`
              : "无使用门槛",
          validity: `${coupon.validFrom.slice(0, 10)} 至 ${coupon.expiresAt.slice(0, 10)}`,
          statusLabel: statusLabels[coupon.status],
        })),
      });
    } catch (error) {
      this.setData({
        coupons: [],
        error: error instanceof Error ? error.message : "优惠券读取失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  changeStatus(event: {
    currentTarget: { dataset: { status: CustomerCouponStatus } };
  }) {
    const activeStatus = event.currentTarget.dataset.status;
    if (activeStatus === this.data.activeStatus) return;
    this.setData({ activeStatus });
    void this.load();
  },
  showUsageHistory() {
    this.setData({ activeStatus: "USED" as CustomerCouponStatus });
    void this.load();
  },
  goUse() {
    wx.switchTab({ url: "/pages/services/index" });
  },
});
