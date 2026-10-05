type CustomTabBar = {
  setData(data: { selected: number }): void;
};

type TabPage = {
  getTabBar?: () => CustomTabBar | null;
};

export function syncCustomTabBar(page: unknown, selected: number) {
  const tabBar = (page as TabPage).getTabBar?.();
  if (tabBar) tabBar.setData({ selected });
}
