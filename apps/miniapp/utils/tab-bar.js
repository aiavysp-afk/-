"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncCustomTabBar = syncCustomTabBar;
function syncCustomTabBar(page, selected) {
    var _a, _b;
    const tabBar = (_b = (_a = page).getTabBar) === null || _b === void 0 ? void 0 : _b.call(_a);
    if (tabBar)
        tabBar.setData({ selected });
}
