/**
 * The TypeScript provider.
 *
 * These are about what the generator decides: which types exist, what the decoder checks, what is
 * declared lost. Whether the output *compiles* under a consumer's own strictness, and whether the
 * decoder actually decodes, is checked by `npm run verify` — which runs `tsc` over every combination
 * and then runs the generated modules against payloads that satisfy the model and payloads that break
 * each rule in turn.
 *
 * Three of the facts below were found only by compiling or running: a `Problems` with both a field and
 * a method named `at`, a shape guard whose narrowing was lost when its `return` was stripped, and a
 * field's own constraints never being applied at all.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl, type LinkedModel } from "@sevenk/core";
import { buildNames, compileRules, withDefaults, type Request } from "@sevenk/generate";
import { node } from "../src/index.js";

/**
 * The same fixture `npm run verify` compiles and `npm run equivalence` drives.
 *
 * Read rather than inlined: a second copy would drift, and the model's own comments contain backticks
 * that a template literal would end.
 */
const MODEL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "verify", "model", "shop.7k"),
  "utf8",
);

const model = (source = MODEL): LinkedModel =>
  buildWorkspace([{ path: "shop.7k", source }]).model;

function request(
  m: LinkedModel,
  options: Record<string, unknown> = {},
  layout: Request["layout"] = "single",
): Request {
  const { names } = buildNames(m, []);
  const compiled = compileRules(m, []);
  // Through the same defaulting the CLI uses, so a test cannot pass on a default the CLI never applies.
  const defaults = withDefaults(node.options, options);
  return {
    model: m,
    selected: m.decls,
    names,
    layout,
    options: defaults,
    optionsFor: (decl: Decl) => compiled.resolve(decl, defaults).options,
  };
}

const run = (...args: Parameters<typeof request>) => node.generate(request(...args));

const named = (out: ReturnType<typeof run>, path: string): string =>
  out.artifacts.find((a) => a.path === path)?.content ?? "";

const code = (options: Record<string, unknown> = {}) => named(run(model(), options), "model.ts");

const lossesOf = (options: Record<string, unknown> = {}) =>
  run(model(), options).artifacts.flatMap((a) => a.losses);

describe("the types", () => {
  const at = () => code();

  it("writes a message as an interface of readonly fields", () => {
    const text = at();
    expect(text).toContain("export interface PlaceOrder {");
    expect(text).toContain("readonly orderId: Uuid;");
    expect(text).toContain("readonly items: readonly Item[];");
  });

  it("marks an optional field optional rather than nullable", () => {
    // There is no null in 7K: an absent field has its key omitted (`01-kernel.md` 7.2).
    expect(at()).toContain("readonly note?: Line60;");
  });

  it("brands a nominal value, which structural typing would otherwise lose", () => {
    expect(at()).toContain('export type Currency = Branded<string, "Currency">;');
  });

  it("keeps a decimal a string, because a `number` is a double", () => {
    // Money must not round-trip through one (`01-kernel.md` 7.1), and the scale is in the type so
    // that two decimals of different scale are different types.
    expect(at()).toContain('export type Money = Branded<Decimal<18, 2>, "Money">;');
  });

  it("writes an enum as a union of literals, not a TypeScript `enum`", () => {
    // A union *is* the canonical encoding and narrows exhaustively; an `enum` is a runtime object
    // with reverse mappings that does not serialise as the member name.
    const text = at();
    expect(text).toContain('export type Status = "Open" | "Shipped";');
    expect(text).not.toContain("export enum Status");
  });

  it("writes a map as a record, which is what its encoding is", () => {
    expect(at()).toContain("readonly rates: Readonly<Record<Currency, Money>>;");
  });

  it("says what the model constrains, where somebody will read it", () => {
    const text = at();
    expect(text).toContain("The model constrains it: size 1..50.");
    expect(text).toContain("`@role(businessKey)`.");
  });
});

describe("the decoder, which is the whole of the checking here", () => {
  const at = () => code();

  it("takes `unknown` and gives back the value or the reasons", () => {
    // A function returning `boolean` would leave the caller to assert, and an assertion is where the
    // guarantee leaks. `JSON.parse(body) as PlaceOrder` compiles and is a claim nobody checked.
    const text = at();
    expect(text).toContain("export const decodePlaceOrder = (value: unknown): Decoded<PlaceOrder> =>");
    expect(text).toContain("return decoded === undefined || !problems.ok");
  });

  it("checks the shape a branded type claims, which C# gets from its runtime", () => {
    const text = at();
    expect(text).toContain("!UUID.test(");
    expect(text).toContain("!INSTANT.test(");
    expect(text).toContain("!BASE64URL.test(");
  });

  it("checks a decimal at exactly the declared scale", () => {
    // `12.5` is not a `decimal(18,2)` and `"12.50"` is.
    expect(at()).toContain("!decimalAt(2).test(");
  });

  it("applies a field's own constraints, which are not its type's", () => {
    // `items: [Item] { size 1..50 }` says something about the field that `Item` knows nothing about.
    // These were dropped entirely until a behaviour check caught it.
    const text = at();
    expect(text).toContain('problems.add("size 1..50")');
  });

  it("applies the constraints along a chain of values", () => {
    // `Line60 : Line` is bound by both.
    const text = at();
    expect(text).toContain('problems.add("length 1..60")');
    expect(text).toContain("lineInto(value, problems)");
  });

  it("compares a decimal's range numerically, not as text", () => {
    // `"9"` is greater than `"10"` as text and is not as a number.
    expect(at()).toContain("if (Number(value) < 0) problems.add");
  });

  it("refuses a null rather than taking it for an empty value", () => {
    expect(at()).toContain("there is no null in 7K: omit the key instead");
  });

  it("builds a path as it descends, so a caller can say which field", () => {
    const text = at();
    expect(text).toContain('here.under("items")');
    expect(text).toContain(".at(index)");
  });

  it("checks an invariant once every field is in hand", () => {
    const text = at();
    expect(text).toContain("decoded.total.currency === decoded.settleIn");
    expect(text).toContain('here.add("invariant total.currency == settleIn")');
  });

  it("projects an invariant over a list, which the whole message being in hand allows", () => {
    // The SQL provider has to declare this one lost: its elements are rows in another table.
    expect(at()).toContain("decoded.items.every((e) => decoded.total.currency === e.unit.currency)");
  });
});

describe("what it declares lost", () => {
  it("says `normalize` transforms where a decoder only accepts", () => {
    const loss = lossesOf().find((l) => l.construct === "normalize");
    expect(loss?.detail).toContain("transforms a value and a decoder only accepts or rejects");
  });

  it("says an `int` past 2^53 stops being exact, and only where one is", () => {
    // A loss on every `int` would be noise that teaches people to ignore the list.
    const losses = lossesOf().filter((l) => l.construct === "int");
    expect(losses).toHaveLength(1);
    expect(losses[0]?.at).toBe("PlaceOrder.count");
  });

  it("says an alias is not nominal, because TypeScript is structural", () => {
    const loss = lossesOf({ valueTypes: "alias" }).find((l) => l.construct === "nominal value");
    expect(loss?.detail).toContain("any value of that type is accepted");
  });

  it("says a type with no decoder is a type a cast satisfies", () => {
    const loss = lossesOf({ decoders: false }).find((l) => l.construct === "decoder");
    expect(loss?.detail).toContain("nothing checks a payload");
    expect(code({ decoders: false })).not.toContain("decodePlaceOrder");
  });
});

describe("the modules", () => {
  it("imports only the kernel aliases it mentions", () => {
    // A generated import nobody uses fails `noUnusedLocals`, which is the lint a consumer most often
    // has on — and a generated file that fails their lint is one they exclude from linting.
    const text = code();
    expect(text).toContain("import type {");
    expect(text).toContain("} from \"./kernel.js\";");
  });

  it("writes the kernel and the runtime once", () => {
    const paths = run(model()).artifacts.map((a) => a.path);
    expect(paths).toContain("kernel.ts");
    expect(paths).toContain("decode.ts");
    expect(paths.filter((p) => p === "kernel.ts")).toHaveLength(1);
  });

  it("writes no runtime where nothing decodes", () => {
    expect(run(model(), { decoders: false }).artifacts.map((a) => a.path)).not.toContain("decode.ts");
  });

  it("writes relative specifiers that reach across packages", () => {
    const out = run(model(), {}, "per-declaration");
    expect(named(out, "shop/Amount.ts")).toContain('from "./Money.js"');
    // A module one directory down reaches the kernel with `..`, which is the case a flat join gets
    // wrong.
    expect(named(out, "shop/Money.ts")).toContain('from "../kernel.js"');
  });

  it("drops the extension where a bundler wants it dropped", () => {
    const out = run(model(), { extension: "" }, "per-declaration");
    expect(named(out, "shop/Amount.ts")).toContain('from "./Money"');
  });

  it("offers one import for everything", () => {
    const index = named(run(model()), "index.ts");
    expect(index).toContain('export * from "./model.js";');
    expect(index).toContain('export * from "./kernel.js";');
  });

  it("writes none where asked", () => {
    expect(run(model(), { index: false }).artifacts.map((a) => a.path)).not.toContain("index.ts");
  });

  it("claims no provenance for the kernel, because no declaration produced it", () => {
    const out = run(model());
    expect(out.artifacts.find((a) => a.path === "kernel.ts")?.from).toEqual([]);
    expect(out.artifacts.find((a) => a.path === "model.ts")?.from).toContain("shop.PlaceOrder");
  });
});

describe("handler interfaces", () => {
  const at = () => code();

  it("writes an interface per service, and no implementation of it", () => {
    // The model describes a service's interface and never its internals, so there is nothing here to
    // put a body in. A generated class would be a guess in a file marked "do not edit".
    const text = at();
    expect(text).toContain("export interface Desk {");
    expect(text).not.toContain("export class Desk");
  });

  it("takes the message, its envelopes, then a signal", () => {
    // `AbortSignal` is the TypeScript equivalent of a cancellation token, and what `fetch` takes.
    expect(at()).toContain(
      ["  handlePlaceOrder(", "    message: PlaceOrder,", "    trace: Trace,", "    signal?: AbortSignal,", "  ): Promise<PlaceOrderOutcome>;"].join("\n"),
    );
  });

  it("writes several replies as a discriminated union", () => {
    // Which is all TypeScript needs. The C# provider has to generate a sealed hierarchy *and* a
    // `Match` taking a delegate per case, because a `switch` over a hierarchy is not
    // exhaustiveness-checked there however closed the hierarchy is.
    const text = at();
    expect(text).toContain("export type PlaceOrderOutcome =");
    expect(text).toContain('| { readonly kind: "Done"; readonly message: Done }');
    expect(text).toContain('| { readonly kind: "Failed"; readonly message: Failed };');
  });

  it("returns the one reply directly where the model declares one", () => {
    const text = at();
    expect(text).toContain("): Promise<void>;");
    expect(text).not.toContain("ChargedOutcome");
  });

  it("demands idempotency where delivery implies redelivery", () => {
    expect(at()).toContain("**This handler must be idempotent.**");
  });

  it("names the deduplication key, and whose job it is", () => {
    expect(at()).toContain("Deduplicated by `orderId`, the message's `@role(businessKey)`");
  });

  it("carries what the service emits and does not return", () => {
    // Without it there is no way to send a `Notify`, and the interface is unusable.
    const text = at();
    expect(text).toContain("export interface DeskOutbound {");
    expect(text).toContain("publishNotify(message: Notify, signal?: AbortSignal): Promise<void>;");
  });

  it("leaves out a reply, which the handler returns instead", () => {
    expect(at()).not.toContain("publishDone(");
  });

  it("writes nothing where asked", () => {
    expect(code({ handlers: false })).not.toContain("export interface Desk {");
  });
});

describe("the saga machine", () => {
  const at = () => code();

  it("makes every state field optional, because state is assigned only from a message (D16)", () => {
    const text = at();
    expect(text).toContain("export interface CheckoutState {");
    expect(text).toContain("total?: Amount;");
    expect(text).toContain("authId?: Uuid;");
  });

  it("keys the instance from the field the model names", () => {
    expect(at()).toContain("new CheckoutSaga(String(message.orderId)");
  });

  it("applies the start block before announcing anything", () => {
    const text = at();
    expect(text.indexOf("saga.state.total = message.total;")).toBeLessThan(
      text.indexOf('effects.push({ kind: "started"'),
    );
  });

  it("dispatches on the message type rather than guessing from its shape", () => {
    // The type is envelope metadata (`01-kernel.md` 7.3), and two messages with the same fields are
    // structurally identical — so a guess from the body would be wrong exactly where it mattered.
    const text = at();
    expect(text).toContain('if (messageType === "shop.Charged") {');
    expect(text).toContain("deliver(messageType: string, raw: unknown)");
  });

  it("guards a timer against the stage it was armed in", () => {
    // Without this a late firing rejects a saga that had already moved on.
    expect(at()).toContain("if (stage !== this.stage || this.joined.has(step)) return effects;");
  });

  it("announces the terminal before the compensation it causes", () => {
    const text = at();
    expect(text.indexOf('effects.push({ kind: "ended"')).toBeLessThan(
      text.indexOf('if (terminal !== "complete") this.unwind(effects);'),
    );
  });

  it("reverses the completed steps in reverse order, and only those", () => {
    // Completion order, not declaration order: for a stage the two differ and only one means anything.
    expect(at()).toContain("for (let i = this.done.length - 1; i >= 0; i--) {");
  });

  it("says a step cannot be reversed rather than pretending it can", () => {
    expect(at()).toContain('effects.push({ kind: "irreversible", step: "notify" });');
  });

  it("names no step for a deadline, because none ended it", () => {
    expect(at()).toContain('this.terminate(effects, "abandoned", undefined, "deadline elapsed");');
  });

  it("fails loudly where the model reads state it never assigned", () => {
    // The checker proves this cannot happen; if it does, the saga is what is wrong.
    expect(at()).toContain("is unset at this point. The model does not assign it before it is read.");
  });

  it("refuses a send the model does not determine", () => {
    const broken = MODEL.replace("send Charge { amount = state.total }", "send Charge");
    const refusal = run(model(broken)).refusals.find((r) => r.at.includes("Checkout"));
    expect(refusal?.declared).toContain("`send shop.Charge` without `amount`");
    expect(refusal?.because).toContain("add the assignment to the model");
  });

  it("writes the shared effect union once, and not at all without a saga", () => {
    expect(run(model()).artifacts.map((a) => a.path)).toContain("saga.ts");
    expect(run(model(), { sagas: false }).artifacts.map((a) => a.path)).not.toContain("saga.ts");
  });

  it("writes the effects as a discriminated union a host can switch on", () => {
    const text = named(run(model()), "saga.ts");
    expect(text).toContain("export type SagaEffect =");
    expect(text).toContain('readonly kind: "send";');
    expect(text).toContain("export interface SagaMachine {");
  });
});
