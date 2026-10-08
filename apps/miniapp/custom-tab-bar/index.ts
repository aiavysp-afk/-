import { requireVerifiedCustomerAccess } from "../utils/auth";

type TabItem = {
  pagePath: string;
  text: string;
  icon: string;
};

Component({
  data: {
    selected: 0,
    list: [
      { pagePath: "/pages/home/index", text: "首页", icon: "⌂" },
      { pagePath: "/pages/discover/index", text: "发现", icon: "◇" },
      { pagePath: "/pages/services/index", text: "下单", icon: "约" },
      { pagePath: "/pages/messages/index", text: "消息", icon: "•••" },
      { pagePath: "/pages/profile/index", text: "我的", icon: "人" },
    ] as TabItem[],
  },
  methods: {
    switchTab(
      this: { data: { list: TabItem[]; selected: number } },
      event: { currentTarget: { dataset: { index: number } } },
    ) {
      if (!requireVerifiedCustomerAccess()) return;
      const index = Number(event.currentTarget.dataset.index);
      const item = this.data.list[index];
      if (!item || index === this.data.selected) return;
      wx.switchTab({ url: item.pagePath });
    },
  },
});
