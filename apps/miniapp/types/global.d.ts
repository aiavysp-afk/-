declare function App<T extends object>(options: T): void;
declare function Page<T extends object>(
  options: T & ThisType<T & { setData(data: Record<string, unknown>): void }>,
): void;
declare function Component<T extends object>(options: T): void;
declare function getApp<T extends object>(): T;
declare function setInterval(handler: () => void, timeout?: number): number;
declare function clearInterval(handle: number): void;
declare const wx: {
  getLocation(options: {
    type: "gcj02";
    isHighAccuracy?: boolean;
    highAccuracyExpireTime?: number;
    success(result: {
      latitude: number;
      longitude: number;
      accuracy: number;
    }): void;
    fail(error: { errMsg: string }): void;
  }): void;
  openLocation(options: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
    scale?: number;
  }): void;
  openCustomerServiceChat?(options: {
    corpId: string;
    extInfo: { url: string };
    fail(error: { errMsg: string }): void;
  }): void;
  makePhoneCall(options: {
    phoneNumber: string;
    fail(error: { errMsg: string }): void;
  }): void;
  requestPayment(options: {
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: "RSA";
    paySign: string;
    success(): void;
    fail(error: { errMsg: string }): void;
  }): void;
  navigateTo(options: { url: string }): void;
  navigateBack(options?: { delta?: number }): void;
  reLaunch(options: { url: string; complete?(): void }): void;
  switchTab(options: { url: string }): void;
  showModal(options: {
    title: string;
    content: string;
    confirmText?: string;
    showCancel?: boolean;
    success?(result: { confirm: boolean; cancel: boolean }): void;
    fail?(): void;
    complete?(): void;
  }): void;
  showActionSheet(options: {
    itemList: string[];
    success?(result: { tapIndex: number }): void;
    fail?(): void;
  }): void;
  showToast(options: {
    title: string;
    icon: "none" | "success" | "error" | "loading";
  }): void;
  login(options: {
    success(result: { code: string }): void;
    fail(error: { errMsg: string }): void;
  }): void;
  request<T>(options: {
    url: string;
    method: "GET" | "POST" | "DELETE";
    data?: unknown;
    header?: Record<string, string>;
    timeout?: number;
    success(result: { statusCode: number; data: T }): void;
    fail(error: { errMsg: string }): void;
  }): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
};
