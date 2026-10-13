/**
 * The coverage declaration, against what this provider actually does.
 *
 * `covers` is read by somebody deciding whether to commit a model to TypeScript, which makes it the
 * most consequential thing here that is not code — and the easiest to let drift, because nothing in
 * a generated module disagrees with a sentence in a declaration. This is what disagrees with it: the
 * fixture is the one `npm run verify` compiles and `npm run equivalence` drives, so the losses here
 * are the losses a model reaching this provider's gaps produces.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl } from "@sevenk/core";
import {
  buildNames,
  compileRules,
  coverageFaults,
  overclaimed,
  withDefaults,
  type Request,
} from "@sevenk/generate";
import { node } from "../src/index.js";

const MODEL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "verify", "model", "shop.7k"),
  "utf8",
);

const generated = (options: Record<string, unknown>) => {
  const m = buildWorkspace([{ path: "shop.7k", source: MODEL }]).model;
  const { names } = buildNames(m, []);
  const compiled = compileRules(m, []);
  const defaults = withDefaults(node.options, options);
  const request: Request = {
    model: m,
    selected: m.decls,
    names,
    layout: "single",
    options: defaults,
    optionsFor: (decl: Decl) => compiled.resolve(decl, defaults).options,
  };
  return node.generate(request);
};

describe("what this provider says it can do", () => {
  it("says it in a form a reader can act on", () => {
    expect(coverageFaults(node, "node")).toEqual([]);
  });

  it("does not claim coverage it then loses", () => {
    expect(overclaimed(node, generated({}).artifacts, "node")).toEqual([]);
  });

  it("is checked against a fixture that actually loses things", () => {
    // Otherwise the test above passes by the fixture being easy, which is the way a claim like this
    // rots: green on a model that never reaches the gaps. Read across the settings rather than at
    // the defaults, because two of the gaps only open when an option is turned the other way —
    // which is exactly when a reader goes looking for this declaration.
    const constructs = new Set(
      [{}, { valueTypes: "alias" }, { decoders: false }].flatMap((options) =>
        generated(options).artifacts.flatMap((a) => a.losses.map((l) => l.construct)),
      ),
    );
    expect([...constructs].sort()).toEqual(["decoder", "int", "nominal value", "normalize"]);
  });

  it("holds under the settings that change what is generated", () => {
    // Three of the entries name an option, so the claim has to survive both sides of each.
    for (const options of [
      { valueTypes: "alias" },
      { decoders: false },
      { handlers: false, devHost: false },
      { devHost: true },
    ]) {
      expect(overclaimed(node, generated(options).artifacts, "node")).toEqual([]);
    }
  });
});
