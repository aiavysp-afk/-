import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const pagePath = new URL("../apps/miniapp/pages/booking/", import.meta.url);
const markup = readFileSync(new URL("index.wxml", pagePath), "utf8");
const styles = readFileSync(new URL("index.wxss", pagePath), "utf8");

function fixture() {
  const navigations = [];
  let page;
  vm.runInNewContext(readFileSync(new URL("index.js", pagePath), "utf8"), {
    exports: {},
    require() { return {}; },
    Page(definition) {
      page = {
        ...definition,
        data: structuredClone(definition.data),
        setData(values) { Object.assign(this.data, values); },
      };
    },
    wx: { navigateTo: (value) => navigations.push(value) },
  });
  return { page, navigations };
}

test("booking puts the editable service address before the project and appointment", () => {
  const address = markup.indexOf('class="panel address-panel booking-first-panel"');
  const service = markup.indexOf('class="service-card"');
  const appointment = markup.indexOf('class="panel appointment-panel"');
  assert.ok(address >= 0 && address < service && service < appointment);
  assert.equal([...markup.matchAll(/class="panel address-panel/g)].length, 1);
  for (const field of ["contactName", "phone", "detail", "doorNumber"]) {
    assert.match(markup, new RegExp(`data-field="${field}" bindinput="input" disabled="\\{\\{busy \\|\\| orderSubmissionAttempted\\}\\}"`));
  }
  assert.match(markup, /bindtap="chooseSavedAddress" disabled="\{\{busy \|\| orderSubmissionAttempted\}\}"/);
  assert.match(markup, /bindtap="selectAddress" disabled="\{\{busy \|\| orderSubmissionAttempted\}\}"/);
});

test("project details navigation encodes identifiers and never shares a booking draft", () => {
  const f = fixture();
  Object.assign(f.page.data, {
    service: { slug: "服务&slug=other?next=/private" },
    preferredTherapistId: "tech&orderId=private",
    phone: "13800138000",
    contactName: "测试客户",
    detail: "私密上门地址",
    reservationId: "existing-hold",
    quoteDetails: { payable: "458.00" },
    orderKey: "synthetic-private-key",
  });
  const before = structuredClone(f.page.data);
  f.page.openServiceDetail();
  assert.equal(f.navigations.length, 1);
  const path = f.navigations[0].url;
  const url = new URL(path, "https://fixture.invalid");
  assert.equal(url.pathname, "/pages/service-detail/index");
  assert.deepEqual([...url.searchParams.keys()], ["slug", "therapistId"]);
  assert.equal(url.searchParams.get("slug"), f.page.data.service.slug);
  assert.equal(url.searchParams.get("therapistId"), f.page.data.preferredTherapistId);
  assert.doesNotMatch(path, /13800138000|existing-hold|synthetic-private-key|458\.00/);
  assert.deepEqual(f.page.data, before);
});

test("project details navigation omits an absent preferred technician", () => {
  const f = fixture();
  f.page.data.service = { slug: "french-spa-120" };
  f.page.openServiceDetail();
  assert.equal(f.navigations[0].url, "/pages/service-detail/index?slug=french-spa-120");
});

test("project preview cannot interrupt a busy or submitted order", () => {
  for (const state of [{ service: null }, { busy: true }, { orderSubmissionAttempted: true }]) {
    const f = fixture();
    Object.assign(f.page.data, { service: { slug: "french-spa-120" }, ...state });
    f.page.openServiceDetail();
    assert.equal(f.navigations.length, 0);
  }
  assert.match(markup, /bindtap="openServiceDetail" disabled="\{\{busy \|\| orderSubmissionAttempted\}\}"/);
});

test("booking retains server pricing, real availability, and both verified WeChat payment paths", () => {
  assert.match(markup, /仅使用后台真实可预约时段/);
  assert.match(markup, /最终金额由服务器核价/);
  assert.match(markup, /quoteDetails\?quoteDetails\.payable:'—'/);
  assert.match(markup, /data-mode="WECHAT" bindtap="choosePaymentMode"/);
  assert.match(markup, /data-mode="FRIEND" bindtap="choosePaymentMode"/);
  assert.match(markup, /仅服务器确认付款后订单才会变为已支付/);
  assert.match(markup, /当前预约系统每单支持 1 项服务/);
  assert.match(markup, /本项目为非医疗、正规上门服务/);
  assert.doesNotMatch(markup, /<textarea|data-field="(?:note|notes|remark|remarks)"|data-mode="ALIPAY"/);
});

test("project duration and subtitle get the requested two-point readability increase", () => {
  assert.match(styles, /\.service-subtitle\s*\{[^}]*font-size:\s*29rpx;[^}]*font-weight:\s*600;/s);
  assert.match(styles, /\.service-tags text\s*\{[^}]*font-size:\s*25rpx;[^}]*font-weight:\s*600;/s);
  assert.match(styles, /\.boundary-list text, checkbox-group\s*\{[^}]*font-size:\s*26rpx;/);
  assert.match(styles, /\.address-actions\s*\{\s*grid-template-columns:\s*1fr;/);
});
