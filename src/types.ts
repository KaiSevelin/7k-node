/**
 * 7K's kernel types, in TypeScript.
 *
 * **The difference from a compiled target is where the checking happens, and it changes everything.**
 * A C# `PlaceOrder` is checked by the compiler and arrives as a `PlaceOrder`; a TypeScript one is
 * checked by the compiler and arrives as `unknown`, because a type is gone by the time a message comes
 * off a queue. So a validator is a convenience in C# and the only thing standing between the wire and
 * the code here — which is why this provider's centre is a **decoder** rather than a type, and why the
 * types below exist mostly to be the decoder's output.
 *
 * Three choices follow from that, and each is the honest one rather than the convenient one:
 *
 * - **A `decimal` is a string.** 7K's canonical JSON writes `decimal(p,s)` as a string with exactly `s`
 *   digits and never as a number, because a JSON number is a double and money must not round-trip
 *   through one (`01-kernel.md` 7.1). A TypeScript `number` *is* that double. So a decimal stays the
 *   string it arrives as, branded, and arithmetic on it is a decision the holder makes with a library
 *   rather than one this provider makes for them by parsing.
 * - **An `int` is a `number`, and that is a declared loss above 2^53.** `bigint` would be exact and
 *   would not survive `JSON.stringify`, so it would break the encoding to fix a range almost nothing
 *   uses. The loss is declared where a field's own `range` reaches that far.
 * - **A nominal value is a branded type.** TypeScript is structural, so `Sku` and `string` are the same
 *   type to it unless something is done; a brand is the something, and it costs nothing at runtime.
 */

import type { Decl, FieldIr, LinkedModel, TypeIr } from "@sevenk/core";

/** Where `number` stops being exact. */
export const SAFE_INTEGER = 9007199254740991;

export interface TypeProblem {
  readonly at: string;
  readonly declared: string;
  readonly because: string;
}

export interface Context {
  readonly model: LinkedModel;
  /** How a nominal value is rendered: branded, or the type it refines. */
  readonly valueTypes: "brand" | "alias";
  /** The package being written, so a reference inside it needs no import. */
  readonly pkgOf: string;
}

/** camelCase, from whatever the model wrote. */
export const camel = (name: string): string => {
  const parts = words(name);
  return parts
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
};

/** PascalCase, for a type name. */
export const pascal = (name: string): string =>
  words(name)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join("");

const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter((w) => w !== "");

/** A module path from a 7K package: `shop.orders` becomes `shop/orders`. */
export const moduleOf = (pkg: string): string =>
  pkg === "" ? "model" : pkg.split(".").filter((p) => p !== "").join("/");

export const qualified = (decl: Decl): string =>
  decl.id.pkg === "" ? decl.id.name : `${decl.id.pkg}.${decl.id.name}`;

/** What a reference points at. */
export const declOf = (type: TypeIr, ctx: Context): Decl | undefined =>
  type.t === "ref" ? ctx.model.declFor(type.ref) : undefined;

export interface Typed {
  readonly text: string;
  readonly problems: readonly TypeProblem[];
}

/**
 * The TypeScript type for a 7K type.
 *
 * `imports` is collected by the caller from `declOf`: a type in another package is referenced by its
 * bare name and imported, because a fully qualified name is not a thing TypeScript has.
 */
export function tsType(type: TypeIr, ctx: Context, at: string): Typed {
  switch (type.t) {
    case "kernel":
      return kernel(type, at);

    case "list": {
      const item = tsType(type.item, ctx, at);
      return { text: `readonly ${wrap(item.text)}[]`, problems: item.problems };
    }

    case "map": {
      const key = tsType(type.key, ctx, at);
      const value = tsType(type.value, ctx, at);
      // `Readonly<Record<K, V>>` and not a `Map`: the canonical encoding of a map is a JSON object,
      // and a `Map` would need converting on the way in and out for nothing.
      return {
        text: `Readonly<Record<${key.text}, ${value.text}>>`,
        problems: [...key.problems, ...value.problems],
      };
    }

    case "ref": {
      const decl = declOf(type, ctx);
      if (decl === undefined) {
        // The model would not have checked, so this is defensive rather than expected.
        return {
          text: "unknown",
          problems: [
            { at, declared: type.ref.text, because: `\`${type.ref.text}\` does not resolve` },
          ],
        };
      }

      // A value is nominal in 7K. As an alias it becomes the type it refines, which TypeScript cannot
      // tell apart from any other of that type — a real loss, and why `brand` is the default.
      if (decl.kind === "value" && ctx.valueTypes === "alias") {
        return tsType(decl.base, ctx, at);
      }

      return { text: pascal(decl.id.name), problems: [] };
    }

    default:
      return {
        text: "unknown",
        problems: [{ at, declared: type.text, because: "this provider does not know that type" }],
      };
  }
}

/** Parenthesised where an array suffix would otherwise bind to the wrong thing. */
const wrap = (text: string): string => (/[|&]/.test(text) ? `(${text})` : text);

function kernel(type: Extract<TypeIr, { t: "kernel" }>, at: string): Typed {
  switch (type.name) {
    case "bool":
      return { text: "boolean", problems: [] };

    // A `number`, and the loss is declared by `intLoss` where a declared range reaches past 2^53.
    case "int":
      return { text: "number", problems: [] };

    case "float":
      return { text: "number", problems: [] };

    case "string":
      return { text: "string", problems: [] };

    // base64url text, which is what the canonical encoding is. Not a `Uint8Array`: that is not JSON,
    // and a decoder handing one back would make the type disagree with the wire.
    case "bytes":
      return { text: "Base64Url", problems: [] };

    case "uuid":
      return { text: "Uuid", problems: [] };

    case "instant":
      return { text: "Instant", problems: [] };

    case "duration":
      return { text: "Duration", problems: [] };

    case "date":
      return { text: "CivilDate", problems: [] };

    default:
      // A string, because the canonical encoding is one and `number` is a double. See the header.
      return { text: `Decimal<${type.precision ?? 18}, ${type.scale ?? 0}>`, problems: [] };
  }
}

/**
 * Whether a field's declared range reaches past what a `number` holds exactly.
 *
 * Checked rather than assumed, because the answer is usually no and a loss declared on every `int`
 * would be noise that teaches people to ignore the list.
 */
export function intLoss(
  field: FieldIr,
  type: TypeIr,
  /** The constraints the field's own type brings with it, which is where the range usually is. */
  inherited: readonly { readonly name: string; readonly args: readonly string[] }[] = [],
): boolean {
  if (type.t !== "kernel" || type.name !== "int") return false;
  for (const constraint of [...field.constraints, ...inherited]) {
    if (constraint.name !== "range") continue;
    for (const arg of constraint.args) {
      const value = Number(arg);
      if (Number.isFinite(value) && Math.abs(value) > SAFE_INTEGER) return true;
    }
  }
  return false;
}

/**
 * The kernel aliases every generated module can rely on.
 *
 * Branded rather than bare, so that a `Uuid` cannot be handed to something wanting an `Instant`
 * because both happen to be strings. The brand exists only in the type system: at runtime each of
 * these *is* the string the wire carried, which is what keeps `JSON.stringify` honest.
 */
export const KERNEL = [
  "/**",
  " * 7K's kernel types, as the canonical JSON carries them (`01-kernel.md` 7).",
  " *",
  " * Each of these is a string at runtime — exactly the string the wire carried — and a distinct type",
  " * at compile time. That pairing is the point: `JSON.stringify` of a decoded message is canonical",
  " * without a serializer, and a `Uuid` still cannot be passed where an `Instant` belongs.",
  " */",
  "declare const brand: unique symbol;",
  "",
  "/** A nominal type over `Base`, distinct from it and from every other brand. */",
  "export type Branded<Base, Name extends string> = Base & { readonly [brand]: Name };",
  "",
  "/** A canonical lowercase hyphenated uuid. */",
  "export type Uuid = Branded<string, \"uuid\">;",
  "",
  "/** RFC 3339, UTC, microsecond precision: `2026-09-30T14:22:05.123456Z`. */",
  "export type Instant = Branded<string, \"instant\">;",
  "",
  "/** ISO 8601 on the wire: `PT30S`. */",
  "export type Duration = Branded<string, \"duration\">;",
  "",
  "/** A civil date with no zone: `2026-09-30`. */",
  "export type CivilDate = Branded<string, \"date\">;",
  "",
  "/** base64url, unpadded. */",
  "export type Base64Url = Branded<string, \"bytes\">;",
  "",
  "/**",
  " * A fixed-point decimal, as the string the contract says it is.",
  " *",
  " * Never a `number`: that is a double, and money must not round-trip through one. The precision and",
  " * scale are in the type so that two decimals of different scale are different types, and so that a",
  " * reader can see what they are without finding the model.",
  " */",
  "export type Decimal<P extends number, S extends number> = Branded<string, `decimal(${P},${S})`>;",
] as const;

/** The module the kernel aliases live in, relative to the output root. */
export const KERNEL_MODULE = "kernel";
