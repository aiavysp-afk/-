import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRenderer } from "./test-hook-renderer";
import {
  SimpleTechniciansPage,
  SimpleOrdersPage,
  SimpleUsersPage,
  type SimpleAdminPageProps,
} from "./simple-admin-pages";

const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial?: unknown) => hooks.current!.useState(initial),
    useMemo: (...args: Parameters<typeof actual.useMemo>) =>
      hooks.current!.useMemo(...args),
    useRef: (...args: Parameters<typeof actual.useRef>) =>
      hooks.current!.useRef(...args),
    useCallback: (...args: Parameters<typeof actual.useCallback>) =>
      hooks.current!.useCallback(...args),
    useEffect: (...args: Parameters<typeof actual.useEffect>) =>
      hooks.current!.useEffect(args[0], args[1] ?? []),
  };
});
beforeEach(() => {
  hooks.current = createHookRenderer();
});
afterEach(() => {
  hooks.current?.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
type Node = { type: unknown; props: Record<string, any> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return text((value as Node).props?.children);
}
function button(tree: unknown, label: string) {
  const result = nodes(tree).find(
    (node) => node.type === "button" && text(node) === label,
  );
  expect(result).toBeDefined();
  return result!;
}
function link(tree: unknown, label: string) {
  const result = nodes(tree).find(
    (node) => node.type === "a" && text(node) === label,
  );
  expect(result).toBeDefined();
  return result!;
}
function pagination(tree: unknown) {
  const component = nodes(tree).find(
    (node) => typeof node.type === "function" && node.type.name === "PageLinks",
  )!;
  return (component.type as (props: Record<string, any>) => unknown)(
    component.props,
  );
}
const props = { token: "isolated-staff", organizationId: "org-a" };
function render(
  component = SimpleTechniciansPage,
  overrides: Partial<SimpleAdminPageProps> = {},
) {
  return hooks.current!.render(() => component({ ...props, ...overrides }));
}
const response = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200 });
const failure = (status: number, message: string) =>
  new Response(JSON.stringify({ message }), { status });
const page = (items: unknown[], nextCursor: string | null = null) =>
  response({ items, nextCursor });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
const technician = {
  technicianId: "tech-one",
  source: "LEGACY_PROFILE",
  name: "测试技师",
  maskedPhone: "138****0000",
  phoneVerified: true,
  version: 7,
  status: "PENDING_REVIEW",
  certificatePhotos: [],
  certificatePhotoStatus: "NOT_UPLOADED",
};
const intake = {
  ...technician,
  technicianId: "intake-one",
  source: "SIMPLE_INTAKE",
  phoneVerified: false,
  certificatePhotoStatus: "AVAILABLE",
  certificatePhotos: [
    {
      id: "intake-one",
      url: "/admin/organizations/org-a/simple/intakes/intake-one/certificate",
    },
  ],
};
const order = {
  id: "order-one",
  orderNo: "TEST-ORDER-001",
  customerNickname: "测试客户",
  appointmentStart: "2026-10-31T02:00:00.000Z",
  status: "PAID",
};
const detail = {
  ...order,
  appointmentEnd: "2026-10-31T03:00:00.000Z",
  serviceAmountFen: 29900,
  travelFeeFen: 0,
  discountFen: 3000,
  payableFen: 26900,
  createdAt: "2026-10-31T00:00:00.000Z",
  technicianName: null,
  items: [
    {
      serviceName: "隔离测试服务",
      durationMinutes: 60,
      unitPriceFen: 29900,
      quantity: 1,
    },
  ],
};
const customer = {
  userId: "user-one",
  displayName: "测试昵称",
  maskedPhone: "139****0011",
  phoneVerified: true,
  createdAt: "2026-10-31T00:00:00.000Z",
};
async function ready(
  component = SimpleTechniciansPage,
  items: unknown[] = [technician],
  overrides: Partial<SimpleAdminPageProps> = {},
) {
  const fetcher = vi.fn().mockResolvedValueOnce(page(items));
  vi.stubGlobal("fetch", fetcher);
  render(component, overrides);
  hooks.current!.flushEffects();
  await flush();
  return fetcher;
}
function selectTechnician(tree: unknown) {
  nodes(tree)
    .find((node) => node.type === "input" && node.props.type === "radio")!
    .props.onChange();
}

describe("three-page scope and action budget", () => {
  it.each([
    [
      "technicians",
      SimpleTechniciansPage,
      3,
      ["姓名", "手机号", "证书照片", "审核状态"],
    ],
    [
      "orders",
      SimpleOrdersPage,
      1,
      ["订单号", "用户昵称", "预约时间", "状态", "操作"],
    ],
    ["users", SimpleUsersPage, 1, ["昵称", "手机号", "注册时间"]],
  ] as const)(
    "%s renders only its required columns and at most three buttons",
    (_name, component, count, headers) => {
      const tree = render(component);
      expect(nodes(tree).filter((node) => node.type === "button")).toHaveLength(
        count,
      );
      expect(
        nodes(tree)
          .filter((node) => node.type === "th")
          .map(text),
      ).toEqual(headers);
      expect(
        nodes(render(component, { hideActions: true })).filter(
          (node) => node.type === "button",
        ),
      ).toHaveLength(0);
      expect(text(tree)).not.toContain("账户安全");
      expect(text(tree)).not.toContain("服务项目");
    },
  );

  it("does not request private lists without an authenticated organization", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(SimpleTechniciansPage, { token: "", organizationId: "" });
    hooks.current!.flushEffects();
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      text(render(SimpleTechniciansPage, { token: "", organizationId: "" })),
    ).toContain("请先登录");
  });

  it("hides previous rows immediately and rejects a late response across identities", async () => {
    const old = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(page([]));
    vi.stubGlobal("fetch", fetcher);
    render(SimpleUsersPage);
    hooks.current!.flushEffects();
    const changed = { token: "new-staff", organizationId: "org-b" };
    expect(text(render(SimpleUsersPage, changed))).not.toContain(
      customer.displayName,
    );
    hooks.current!.flushEffects();
    await flush();
    old.resolve(page([customer]));
    await flush();
    expect(text(render(SimpleUsersPage, changed))).not.toContain(
      customer.displayName,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses a fifteen-second read deadline without a JSON body on GET", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = await ready(SimpleUsersPage, [customer]);
    expect(timeout).toHaveBeenCalledWith(15000);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/\/org-a\/simple\/users\?limit=20$/);
    expect(options.method).toBe("GET");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers).not.toHaveProperty("Content-Type");
    expect(options).not.toHaveProperty("body");
  });
});

describe("pending technician review", () => {
  it("shows no invented certificate photo or identity-document substitute", async () => {
    await ready(SimpleTechniciansPage, [
      {
        ...technician,
        idFrontUrl: "https://private.invalid/identity-front.jpg",
        certificates: ["证书文字"],
      },
    ]);
    const tree = render();
    expect(text(tree)).toContain("未上传证书照片");
    expect(
      nodes(tree)
        .filter((node) => typeof node.type === "string")
        .some((node) =>
          String(node.props.href ?? node.props.src ?? "").includes(
            "identity-front.jpg",
          ),
        ),
    ).toBe(false);
    expect(text(tree)).not.toContain("证书文字");
    expect(text(tree)).toContain(technician.maskedPhone);
    expect(nodes(tree).filter((node) => node.type === "button")).toHaveLength(
      3,
    );
  });

  it("submits the selected displayed version after explicit approval confirmation only once", async () => {
    const fetcher = await ready();
    const pending = deferred<Response>();
    fetcher
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page([]));
    selectTechnician(render());
    button(render(), "通过").props.onClick();
    const confirmation = render();
    expect(
      nodes(confirmation).filter((node) => node.type === "button"),
    ).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    button(confirmation, "确认通过").props.onClick();
    button(confirmation, "确认通过").props.onClick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = fetcher.mock.calls[1]!;
    expect(String(url)).toMatch(/\/technicians\/tech-one\/profile\/approve$/);
    expect(JSON.parse(options.body)).toEqual({ expectedVersion: 7 });
    pending.resolve(
      response({ technicianId: technician.technicianId, status: "APPROVED" }),
    );
    await flush();
    expect(text(render())).toContain("审核已通过");
    expect(text(render())).toContain("暂无待审核技师");
  });

  it("requires a nonempty rejection reason and sends it with the displayed version", async () => {
    const fetcher = await ready();
    fetcher
      .mockResolvedValueOnce(
        response({ technicianId: technician.technicianId, status: "REJECTED" }),
      )
      .mockResolvedValueOnce(page([]));
    selectTechnician(render());
    button(render(), "拒绝").props.onClick();
    button(render(), "确认拒绝").props.onClick();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain("请填写2至500字拒绝原因");
    nodes(render())
      .find((node) => node.type === "textarea")!
      .props.onChange({ target: { value: "资料不完整" } });
    button(render(), "确认拒绝").props.onClick();
    await flush();
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      reason: "资料不完整",
      expectedVersion: 7,
    });
    expect(text(render())).toContain("申请已拒绝");
  });

  it("opens an inline verification request on step-up failure, keeps selection, and hides background actions", async () => {
    const verify = vi.fn();
    const fetcher = await ready(SimpleTechniciansPage, [technician], {
      onRequireVerification: verify,
    });
    fetcher.mockResolvedValueOnce(
      failure(403, "此敏感操作需要先在账户安全完成动态码验证"),
    );
    const options = { onRequireVerification: verify };
    selectTechnician(render(SimpleTechniciansPage, options));
    button(render(SimpleTechniciansPage, options), "通过").props.onClick();
    button(render(SimpleTechniciansPage, options), "确认通过").props.onClick();
    await flush();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const hidden = render(SimpleTechniciansPage, {
      ...options,
      hideActions: true,
    });
    expect(nodes(hidden).filter((node) => node.type === "button")).toHaveLength(
      0,
    );
    expect(text(hidden)).toContain(technician.name);
    expect(text(hidden)).toContain("确认通过");
    expect(
      nodes(render(SimpleTechniciansPage, options)).filter(
        (node) => node.type === "button",
      ),
    ).toHaveLength(2);
  });

  it("does not request MFA for a plain permission denial or fake a completed review", async () => {
    const verify = vi.fn();
    const fetcher = await ready(SimpleTechniciansPage, [technician], {
      onRequireVerification: verify,
    });
    fetcher.mockResolvedValueOnce(failure(403, "当前身份无权执行此操作"));
    const options = { onRequireVerification: verify };
    selectTechnician(render(SimpleTechniciansPage, options));
    button(render(SimpleTechniciansPage, options), "通过").props.onClick();
    button(render(SimpleTechniciansPage, options), "确认通过").props.onClick();
    await flush();
    expect(verify).not.toHaveBeenCalled();
    expect(text(render(SimpleTechniciansPage, options))).toContain(
      "当前账号没有此操作权限",
    );
    expect(text(render(SimpleTechniciansPage, options))).not.toContain(
      "审核已通过",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never claims success for an invalid HTTP 200 review response", async () => {
    const fetcher = await ready();
    fetcher.mockResolvedValueOnce(response({}));
    selectTechnician(render());
    button(render(), "通过").props.onClick();
    button(render(), "确认通过").props.onClick();
    await flush();
    expect(text(render())).not.toContain("审核已通过");
    expect(text(render())).toContain("暂时无法完成请求");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("simple intake review and private certificate", () => {
  it.each(["approve", "reject"] as const)(
    "reviews a simple intake through its own %s route without provisioning a technician",
    async (action) => {
      const fetcher = await ready(SimpleTechniciansPage, [intake]);
      fetcher
        .mockResolvedValueOnce(
          response({
            technicianId: intake.technicianId,
            status: action === "approve" ? "APPROVED" : "REJECTED",
            version: 8,
          }),
        )
        .mockResolvedValueOnce(page([]));
      expect(text(render())).toContain("本人填写，未验证");
      expect(nodes(render()).filter((node) => node.type === "th")).toHaveLength(
        4,
      );
      expect(
        nodes(render()).filter((node) => node.type === "button"),
      ).toHaveLength(3);
      selectTechnician(render());
      button(render(), action === "approve" ? "通过" : "拒绝").props.onClick();
      if (action === "reject")
        nodes(render())
          .find((node) => node.type === "textarea")!
          .props.onChange({ target: { value: "证书信息需核实" } });
      button(
        render(),
        action === "approve" ? "确认通过" : "确认拒绝",
      ).props.onClick();
      await flush();
      expect(String(fetcher.mock.calls[1]![0])).toMatch(
        new RegExp(`/org-a/simple/intakes/intake-one/${action}$`),
      );
      expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
        expectedVersion: 7,
        ...(action === "reject" ? { reason: "证书信息需核实" } : {}),
      });
      expect(
        fetcher.mock.calls.some(
          ([url]) =>
            String(url).includes("/profile/") ||
            String(url).includes("/publish"),
        ),
      ).toBe(false);
      expect(text(render())).toContain(
        action === "approve" ? "不开通接单或创建技师账号" : "原因已保存",
      );
      expect(text(render())).not.toContain("原因已同步技师端");
    },
  );

  it("fetches a certificate with bearer authorization and exposes only a revocable blob preview", async () => {
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:isolated-certificate");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const fetcher = await ready(SimpleTechniciansPage, [intake]);
    fetcher.mockResolvedValueOnce(
      new Response(new Uint8Array([255, 216, 255, 0]), {
        headers: { "Content-Type": "image/jpeg", "Content-Length": "4" },
      }),
    );
    expect(nodes(render()).some((node) => node.type === "img")).toBe(false);
    link(render(), "查看证书照片").props.onClick({ preventDefault() {} });
    await flush();
    expect(fetcher.mock.calls[1]![0]).toBe(
      `http://127.0.0.1:3100/v1${intake.certificatePhotos[0]!.url}`,
    );
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      headers: { Authorization: "Bearer isolated-staff" },
    });
    const tree = render();
    const image = nodes(tree).find((node) => node.type === "img")!;
    expect(image.props.src).toBe("blob:isolated-certificate");
    expect(
      nodes(tree)
        .filter((node) => typeof node.type === "string")
        .every(
          (node) =>
            !String(node.props.href ?? node.props.src ?? "").includes("Bearer"),
        ),
    ).toBe(true);
    expect(nodes(tree).filter((node) => node.type === "button")).toHaveLength(
      3,
    );
    expect(create).toHaveBeenCalledTimes(1);
    link(tree, "收起证书照片").props.onClick({ preventDefault() {} });
    expect(revoke).toHaveBeenCalledWith("blob:isolated-certificate");
    expect(nodes(render()).some((node) => node.type === "img")).toBe(false);
  });

  it("keeps simple intake confirmation after a step-up denial and never replays the review", async () => {
    const verify = vi.fn();
    const options = { onRequireVerification: verify };
    const fetcher = await ready(SimpleTechniciansPage, [intake], options);
    fetcher.mockResolvedValueOnce(
      failure(403, "此敏感操作需要先完成动态码验证"),
    );
    selectTechnician(render(SimpleTechniciansPage, options));
    button(render(SimpleTechniciansPage, options), "通过").props.onClick();
    button(render(SimpleTechniciansPage, options), "确认通过").props.onClick();
    await flush();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const tree = render(SimpleTechniciansPage, {
      ...options,
      hideActions: true,
    });
    expect(nodes(tree).filter((node) => node.type === "button")).toHaveLength(
      0,
    );
    expect(text(tree)).toContain("确认通过");
    expect(text(tree)).not.toContain("入驻申请已通过审核");
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not send authorization to an external or mismatched organization certificate path", async () => {
    for (const url of [
      "https://foreign.invalid/certificate.jpg",
      "/admin/organizations/org-b/simple/intakes/intake-one/certificate",
    ]) {
      hooks.current?.unmount();
      hooks.current = createHookRenderer();
      const fetcher = await ready(SimpleTechniciansPage, [
        { ...intake, certificatePhotos: [{ id: "intake-one", url }] },
      ]);
      const tree = render();
      const previewLink = nodes(tree).find(
        (node) => node.type === "a" && text(node) === "查看证书照片",
      );
      previewLink?.props.onClick({ preventDefault() {} });
      await flush();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(nodes(render()).some((node) => node.type === "img")).toBe(false);
      expect(text(render())).toContain(
        url.startsWith("https:") ? "列表未能读取" : "照片地址与本条申请不符",
      );
    }
  });

  it.each([
    ["image/svg+xml", [255, 216, 255]],
    ["image/jpeg", [60, 115, 118, 103]],
  ])(
    "rejects an unexpected certificate response %s instead of rendering its contents",
    async (contentType, bytes) => {
      const create = vi.spyOn(URL, "createObjectURL");
      const fetcher = await ready(SimpleTechniciansPage, [intake]);
      fetcher.mockResolvedValueOnce(
        new Response(new Uint8Array(bytes), {
          headers: { "Content-Type": contentType },
        }),
      );
      link(render(), "查看证书照片").props.onClick({ preventDefault() {} });
      await flush();
      expect(create).not.toHaveBeenCalled();
      expect(nodes(render()).some((node) => node.type === "img")).toBe(false);
      expect(text(render())).toContain("暂时无法完成请求");
    },
  );

  it("aborts and rejects a late certificate response when the organization changes", async () => {
    const create = vi.spyOn(URL, "createObjectURL");
    const fetcher = await ready(SimpleTechniciansPage, [intake]);
    const pending = deferred<Response>();
    fetcher
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page([]));
    link(render(), "查看证书照片").props.onClick({ preventDefault() {} });
    const signal = fetcher.mock.calls[1]![1].signal as AbortSignal;
    render(SimpleTechniciansPage, { organizationId: "org-b" });
    hooks.current!.flushEffects();
    await flush();
    expect(signal.aborted).toBe(true);
    pending.resolve(
      new Response(new Uint8Array([255, 216, 255]), {
        headers: { "Content-Type": "image/jpeg" },
      }),
    );
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect(
      nodes(render(SimpleTechniciansPage, { organizationId: "org-b" })).some(
        (node) => node.type === "img",
      ),
    ).toBe(false);
  });

  it("revokes a loaded preview on identity changes and prevents preview requests behind MFA", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue(
      "blob:isolated-certificate",
    );
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const fetcher = await ready(SimpleTechniciansPage, [intake]);
    const hidden = render(SimpleTechniciansPage, { hideActions: true });
    link(hidden, "查看证书照片").props.onClick({ preventDefault() {} });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher
      .mockResolvedValueOnce(
        new Response(new Uint8Array([255, 216, 255]), {
          headers: { "Content-Type": "image/jpeg" },
        }),
      )
      .mockResolvedValueOnce(page([]));
    link(render(), "查看证书照片").props.onClick({ preventDefault() {} });
    await flush();
    expect(nodes(render()).some((node) => node.type === "img")).toBe(true);
    render(SimpleTechniciansPage, { token: "another-staff" });
    hooks.current!.flushEffects();
    await flush();
    expect(revoke).toHaveBeenCalledWith("blob:isolated-certificate");
    expect(
      nodes(render(SimpleTechniciansPage, { token: "another-staff" })).some(
        (node) => node.type === "img",
      ),
    ).toBe(false);
  });
});

describe("orders and customers", () => {
  it("opens order details in the same page using a link and server amounts", async () => {
    const fetcher = await ready(SimpleOrdersPage, [order]);
    fetcher.mockResolvedValueOnce(response(detail));
    link(render(SimpleOrdersPage), "查看详情").props.onClick({
      preventDefault() {},
    });
    await flush();
    const tree = render(SimpleOrdersPage);
    expect(nodes(tree).filter((node) => node.type === "button")).toHaveLength(
      1,
    );
    expect(text(tree)).toContain("隔离测试服务");
    expect(text(tree)).toContain("应付金额 ¥269");
    expect(String(fetcher.mock.calls[1]![0])).toMatch(
      /\/simple\/orders\/order-one$/,
    );
    expect(
      nodes(render(SimpleOrdersPage, { hideActions: true })).filter(
        (node) => node.type === "button",
      ),
    ).toHaveLength(0);
    link(tree, "收起详情").props.onClick({ preventDefault() {} });
    expect(text(render(SimpleOrdersPage))).not.toContain("隔离测试服务");
  });

  it("rejects stale order detail after changing the organization", async () => {
    const fetcher = await ready(SimpleOrdersPage, [order]);
    const pending = deferred<Response>();
    fetcher
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page([]));
    link(render(SimpleOrdersPage), "查看详情").props.onClick({
      preventDefault() {},
    });
    render(SimpleOrdersPage, { organizationId: "org-b" });
    hooks.current!.flushEffects();
    await flush();
    pending.resolve(response(detail));
    await flush();
    expect(
      text(render(SimpleOrdersPage, { organizationId: "org-b" })),
    ).not.toContain("隔离测试服务");
  });

  it("keeps order details empty on an invalid response instead of showing zero placeholder money", async () => {
    const fetcher = await ready(SimpleOrdersPage, [order]);
    fetcher.mockResolvedValueOnce(response({ id: order.id }));
    link(render(SimpleOrdersPage), "查看详情").props.onClick({
      preventDefault() {},
    });
    await flush();
    expect(text(render(SimpleOrdersPage))).toContain("暂时无法完成请求");
    expect(text(render(SimpleOrdersPage))).not.toContain("应付金额");
  });

  it("shows masked customer phones without a reveal operation", async () => {
    const fetcher = await ready(SimpleUsersPage, [customer]);
    const tree = render(SimpleUsersPage);
    expect(text(tree)).toContain(customer.maskedPhone);
    expect(text(tree)).toContain("注册时间");
    expect(text(tree)).not.toContain("查看完整");
    expect(
      fetcher.mock.calls.every(
        ([url]) => !String(url).includes("reveal-phone"),
      ),
    ).toBe(true);
  });

  it("fails closed when a customer list unexpectedly includes an unmasked phone", async () => {
    await ready(SimpleUsersPage, [{ ...customer, maskedPhone: "13900000011" }]);
    const tree = render(SimpleUsersPage);
    expect(text(tree)).not.toContain("13900000011");
    expect(text(tree)).not.toContain(customer.displayName);
    expect(text(tree)).toContain("列表未能读取");
  });

  it("makes additional records explicit and uses cursor next/previous links", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page([customer], "next_cursor"))
      .mockResolvedValueOnce(
        page([{ ...customer, userId: "user-two", displayName: "第二页用户" }]),
      )
      .mockResolvedValueOnce(page([customer], "next_cursor"));
    vi.stubGlobal("fetch", fetcher);
    render(SimpleUsersPage);
    hooks.current!.flushEffects();
    await flush();
    const first = pagination(render(SimpleUsersPage));
    expect(text(first)).toContain("还有更多记录");
    link(first, "下一页").props.onClick({ preventDefault() {} });
    await flush();
    expect(String(fetcher.mock.calls[1]![0])).toContain("cursor=next_cursor");
    const second = render(SimpleUsersPage);
    expect(text(second)).toContain("第二页用户");
    expect(text(second)).not.toContain(customer.displayName);
    link(pagination(second), "上一页").props.onClick({ preventDefault() {} });
    await flush();
    expect(String(fetcher.mock.calls[2]![0])).not.toContain("cursor=");
    expect(text(render(SimpleUsersPage))).toContain(customer.displayName);
  });
});
