// Old shared links remain usable without exposing a technician directory.
Page({
  onLoad(options: { slug?: string }) {
    if (options.slug && options.slug.length <= 160)
      wx.redirectTo({
        url:
          "/pages/service-detail/index?slug=" +
          encodeURIComponent(options.slug),
      });
    else wx.switchTab({ url: "/pages/services/index" });
  },
});
