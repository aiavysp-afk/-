"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../utils/auth");
Component({
    data: {
        selected: 0,
        list: [
            { pagePath: "/pages/home/index", text: "首页", icon: "⌂" },
            { pagePath: "/pages/services/index", text: "服务", icon: "✦" },
            { pagePath: "/pages/therapists/index", text: "技师", icon: "人" },
            { pagePath: "/pages/orders/index", text: "订单", icon: "▤" },
            { pagePath: "/pages/profile/index", text: "我的", icon: "●" },
        ],
    },
    methods: {
        switchTab(event) {
            if (!(0, auth_1.requireVerifiedCustomerAccess)())
                return;
            const index = Number(event.currentTarget.dataset.index);
            const item = this.data.list[index];
            if (!item || index === this.data.selected)
                return;
            wx.switchTab({ url: item.pagePath });
        },
    },
});
