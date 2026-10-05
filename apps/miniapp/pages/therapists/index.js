"use strict";
Page({
    data: {
        standards: [
            {
                title: "身份资料核验",
                detail: "工作人员资料由平台后台留存核验，不在公开页面展示证件。",
            },
            {
                title: "按排班选择",
                detail: "实际可约人员和时段以下单页实时排班结果为准。",
            },
            {
                title: "服务全程留痕",
                detail: "订单状态、退款申请和安全事件均在平台记录。",
            },
            {
                title: "正规服务边界",
                detail: "仅提供公示的非医疗养生放松服务，拒绝违法违规要求。",
            },
        ],
    },
    openServices() {
        wx.switchTab({ url: "/pages/services/index" });
    },
});
