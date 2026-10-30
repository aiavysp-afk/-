import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminServiceItem } from "@zydj/contracts";
import { createHookRenderer } from "./test-hook-renderer";
import {
  CatalogServiceEditor,
  catalogDraft,
  catalogPriceFen,
  validateCatalogDraft,
} from "./catalog-service-editor";

const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial?: unknown) => hooks.current!.useState(initial),
}));
afterEach(() => hooks.current?.unmount());
const service: AdminServiceItem = {
  id: "service-fixture",
  slug: "service-fixture",
  organizationId: "org-a",
  name: "测试项目",
  category: "MASSAGE",
  subtitle: "测试项目卖点",
  description: "这里是明确填写的服务详细介绍内容。",
  durationMinutes: 80,
  priceFen: 29801,
  featured: true,
  steps: ["沟通需求", "结束整理"],
  boundaries: ["保健放松服务"],
  published: false,
  updatedAt: "2026-10-30T00:00:00.000Z",
};
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

describe("project pricing and required operational content", () => {
  it.each([
    ["298.01", 29801],
    ["0.01", 1],
    ["0", 0],
    ["218.1", 21810],
    ["1000000.00", 100000000],
    ["1.005", null],
    ["", null],
    ["-1", null],
    ["1e3", null],
    ["001", null],
    ["1,000", null],
    ["1000000.01", null],
    ["Infinity", null],
  ])("converts %s to exact fen without rounding", (input, expected) => {
    expect(catalogPriceFen(String(input))).toBe(expected);
  });

  it("never pre-fills a new project with invented service descriptions", () => {
    const empty = catalogDraft();
    expect(empty.name).toBe("");
    expect(empty.priceYuan).toBe("");
    expect(empty.steps).toBe("");
    expect(empty.boundaries).toBe("");
    expect(validateCatalogDraft(empty).input).toBe(null);
  });

  it("keeps existing data, trims lines and permits an explicitly empty optional badge", () => {
    const draft = catalogDraft(service);
    expect(draft.priceYuan).toBe("298.01");
    const validated = validateCatalogDraft({
      ...draft,
      steps: " 沟通需求 \n\n 结束整理 ",
      badge: " ",
    });
    expect(validated.errors).toEqual([]);
    expect(validated.input).toMatchObject({
      priceFen: 29801,
      steps: service.steps,
      badge: null,
      featured: true,
    });
  });

  it("rejects invalid categories, fractional duration and missing safety instructions", () => {
    const invalid = validateCatalogDraft({
      ...catalogDraft(service),
      category: "invalid",
      durationMinutes: "60.5",
      boundaries: "",
    });
    expect(invalid.input).toBe(null);
    expect(invalid.errors.join(" ")).toMatch(/分类.*时长.*服务说明/);
  });

  it("caps long descriptions and line counts before any network write", () => {
    const invalid = validateCatalogDraft({
      ...catalogDraft(service),
      description: "长".repeat(2001),
      steps: Array(21).fill("步骤").join("\n"),
      boundaries: "界".repeat(161),
    });
    expect(invalid.input).toBe(null);
    expect(invalid.errors).toHaveLength(3);
  });
});

describe("service edit confirmation", () => {
  it("shows a review of price, duration and service content before calling save", () => {
    hooks.current = createHookRenderer();
    const save = vi.fn(async () => {});
    const render = () =>
      hooks.current!.render(() =>
        CatalogServiceEditor({
          service,
          busy: false,
          onSave: save,
          onCancel: () => {},
        }),
      );
    const form = nodes(render()).find((node) => node.type === "form")!;
    form.props.onSubmit({ preventDefault() {} });
    const review = render();
    expect(text(review)).toContain("确认项目内容");
    expect(text(review)).toContain("298.01");
    expect(text(review)).toContain("80分钟");
    expect(text(review)).toContain(service.description);
    expect(save).not.toHaveBeenCalled();
    const confirm = nodes(review).find(
      (node) => node.type === "button" && text(node) === "确认保存项目",
    )!;
    confirm.props.onClick();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: service.name, priceFen: 29801 }),
    );
  });

  it("keeps invalid new-project input in the form and does not call save", () => {
    hooks.current = createHookRenderer();
    const save = vi.fn(async () => {});
    const render = () =>
      hooks.current!.render(() =>
        CatalogServiceEditor({ busy: false, onSave: save, onCancel: () => {} }),
      );
    nodes(render())
      .find((node) => node.type === "form")!
      .props.onSubmit({ preventDefault() {} });
    const result = render();
    expect(text(result)).toContain("项目名称须为");
    expect(text(result)).toContain("服务流程须填写");
    expect(save).not.toHaveBeenCalled();
    expect(nodes(result).some((node) => node.type === "form")).toBe(true);
  });
});
