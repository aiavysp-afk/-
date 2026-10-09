import { describe, expect, it } from "vitest";
import { createLatestRequest } from "./synchronization";

describe("admin response ordering", () => {
  it("ignores an earlier read after a newer read or save begins", () => {
    const requests = createLatestRequest();
    const oldRead = requests.begin();
    const currentRead = requests.begin();
    expect(oldRead()).toBe(false);
    expect(currentRead()).toBe(true);
    const save = requests.begin();
    expect(currentRead()).toBe(false);
    expect(save()).toBe(true);
  });

  it("rejects responses after the organization or technician is unmounted", () => {
    const requests = createLatestRequest();
    const response = requests.begin();
    requests.invalidate();
    expect(response()).toBe(false);
  });
});
