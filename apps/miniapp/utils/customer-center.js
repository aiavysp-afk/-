"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadCustomerCenterOverview = exports.customerCenterPath = exports.rememberCustomerCenterOrganizationId = exports.getCustomerCenterOrganizationId = void 0;
const api_1 = require("./api");
const ORGANIZATION_STORAGE_KEY = "zydj.customer-center.organization-id";
const getCustomerCenterOrganizationId = () => {
    const value = wx.getStorageSync(ORGANIZATION_STORAGE_KEY);
    return typeof value === "string" && value.trim() ? value : undefined;
};
exports.getCustomerCenterOrganizationId = getCustomerCenterOrganizationId;
const rememberCustomerCenterOrganizationId = (organizationId) => {
    if (organizationId.trim())
        wx.setStorageSync(ORGANIZATION_STORAGE_KEY, organizationId);
};
exports.rememberCustomerCenterOrganizationId = rememberCustomerCenterOrganizationId;
const customerCenterPath = (path = "/customer-center", params = {}) => {
    var _a;
    const organizationId = (_a = params.organizationId) !== null && _a !== void 0 ? _a : (0, exports.getCustomerCenterOrganizationId)();
    const query = Object.entries({ ...params, organizationId })
        .filter((entry) => Boolean(entry[1]))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
    return query ? `${path}?${query}` : path;
};
exports.customerCenterPath = customerCenterPath;
const loadCustomerCenterOverview = async () => {
    const overview = await (0, api_1.api)((0, exports.customerCenterPath)());
    (0, exports.rememberCustomerCenterOrganizationId)(overview.organizationId);
    return overview;
};
exports.loadCustomerCenterOverview = loadCustomerCenterOverview;
