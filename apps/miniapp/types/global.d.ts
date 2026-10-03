declare function App<T extends object>(options: T): void;
declare function Page<T extends object>(options: T & ThisType<T & { setData(data: Record<string, unknown>): void }>): void;
declare function getApp<T extends object>(): T;
declare const wx: {
  showToast(options: { title: string; icon: 'none' | 'success' | 'error' | 'loading' }): void;
  login(options: {
    success(result: { code: string }): void;
    fail(error: { errMsg: string }): void;
  }): void;
  request<T>(options: {
    url: string;
    method: 'GET' | 'POST';
    data?: unknown;
    header?: Record<string, string>;
    success(result: { statusCode: number; data: T }): void;
    fail(error: { errMsg: string }): void;
  }): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
};
