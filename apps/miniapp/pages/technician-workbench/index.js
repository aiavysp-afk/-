"use strict";
// Compatibility route: this miniapp no longer provides a technician workbench.
Page({
    onLoad() {
        wx.redirectTo({ url: "/pages/technician-onboarding/index" });
    },
});
