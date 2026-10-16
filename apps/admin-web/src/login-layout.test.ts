import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("sign-in remains reachable in narrow browser panels", () => {
  it("does not force the document to a desktop-only width", () => {
    expect(css).toMatch(/body\s*\{[^}]*min-width:\s*320px/);
    expect(css).not.toMatch(/body\s*\{[^}]*min-width:\s*1120px/);
    expect(css).toContain("grid-template-columns: 248px minmax(0, 1fr)");
    expect(css).toMatch(/main\s*\{[^}]*min-width:\s*0/);
  });

  it("keeps all navigation reachable within a locally scrollable narrow header", () => {
    const responsive = css.slice(css.indexOf("/* Keep sign-in reachable"));
    expect(responsive).toContain("@media (max-width: 760px)");
    expect(responsive).toMatch(
      /\.app-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    expect(responsive).toMatch(/\.sidebar nav\s*\{[^}]*overflow-x:\s*auto/);
    expect(responsive).toMatch(
      /\.sidebar nav button\s*\{[^}]*flex:\s*0 0 auto/,
    );
    expect(responsive).not.toMatch(
      /(?:body|main|\.app-shell|\.sidebar nav)\s*\{[^}]*overflow(?:-x)?:\s*hidden/,
    );
  });

  it("stacks login methods on phones and keeps action targets usable", () => {
    const mobile = css.slice(css.lastIndexOf("@media (max-width: 560px)"));
    expect(mobile).toMatch(
      /\.login-methods\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    expect(mobile).toContain("width: 100%");
    expect(css.slice(css.indexOf("/* Keep sign-in reachable"))).toContain(
      "min-height: 44px",
    );
  });

  it("scrolls a wide project table locally so right-side actions are not clipped", () => {
    expect(css).toMatch(/\.catalog-table\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).not.toMatch(/\.catalog-table\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.catalog-row\s*\{[^}]*min-width:\s*720px/);
  });
});
