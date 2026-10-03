import type { ServiceItem } from "@zydj/contracts";
import { api, money } from "../../utils/api";
type Card = ServiceItem & { price: string };
Page({
  data: {
    categories: ["全部", "按摩舒缓", "SPA 放松", "足部养护"],
    active: 0,
    all: [] as Card[],
    services: [] as Card[],
    loading: false,
    error: "",
  },
  async onShow() {
    await this.load();
  },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const all = (await api<ServiceItem[]>("/catalog/services")).map(
        (item) => ({ ...item, price: money(item.priceFen) }),
      );
      this.setData({ all });
      this.filter();
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "目录加载失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  select(e: { currentTarget: { dataset: { index: number } } }) {
    this.setData({ active: Number(e.currentTarget.dataset.index) });
    this.filter();
  },
  filter() {
    const category = ["", "MASSAGE", "SPA_RELAXATION", "FOOT_CARE"][
      this.data.active
    ];
    this.setData({
      services: this.data.all.filter(
        (item) => !category || item.category === category,
      ),
    });
  },
  book(e: { currentTarget: { dataset: { slug: string } } }) {
    wx.navigateTo({
      url: `/pages/booking/index?slug=${encodeURIComponent(e.currentTarget.dataset.slug)}`,
    });
  },
});
