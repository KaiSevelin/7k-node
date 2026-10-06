/**
 * Does the generated decoder decode what the model says it decodes?
 *
 * Compiling proves it is valid TypeScript. This proves it is *right*: a payload satisfying every rule
 * is accepted, and a payload breaking one is refused with a problem naming the field. Each case is the
 * valid payload with one thing changed, because a hand-written case that happens to break a second
 * rule is refused for the wrong reason and proves nothing.
 *
 * Copied in beside the generated modules rather than importing them from elsewhere, so what runs is
 * the artifact and not a reading of it.
 */

import {
  decodePlaceOrder,
  decodeSku,
  decodeCurrency,
  type PlaceOrder,
} from "./model.js";

let failures = 0;

const say = (what: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};

/** A payload that satisfies every rule the model states. */
const base = (): Record<string, unknown> => ({
  orderId: "11111111-1111-1111-1111-111111111111",
  items: [
    {
      name: "a line",
      sku: "SKU-1",
      qty: 2,
      unit: { value: "12.50", currency: "SEK" },
    },
  ],
  total: { value: "25.00", currency: "SEK" },
  tags: ["red", "blue"],
  rates: { NOK: "1.05" },
  status: "Open",
  token: "AQID",
  stamped: "2026-10-06T14:22:05.123456Z",
  held: "PT30S",
  day: "2026-10-06",
  settleIn: "SEK",
  weight: 1.5,
  count: 1,
});

/** The valid payload with one thing changed. */
const varied = (change: Record<string, unknown>): Record<string, unknown> => ({ ...base(), ...change });

/** Decodes and reports whether the verdict and the path are what the model implies. */
function expect(what: string, payload: unknown, path?: string): void {
  const result = decodePlaceOrder(payload);
  if (path === undefined) {
    say(
      what,
      result.ok,
      result.ok ? undefined : result.problems.map((p) => `${p.path}: ${p.rule}`).join(" | "),
    );
    return;
  }
  if (result.ok) {
    say(what, false, "it decoded, and the model says it should not have");
    return;
  }
  const hit = result.problems.some((p) => p.path === path);
  say(
    what,
    hit,
    hit ? undefined : `wanted a problem at \`${path}\`, got ${result.problems.map((p) => p.path).join(", ")}`,
  );
}

console.log("");

expect("a payload that satisfies every rule", base());

// The shape checks, which a C# provider needs none of: there a Guid is a Guid.
expect("a uuid that is not one", varied({ orderId: "not-a-uuid" }), "orderId");
expect("an instant that is not UTC", varied({ stamped: "2026-10-06T14:22:05+02:00" }), "stamped");
expect("an instant with no fractional digits is fine", varied({ stamped: "2026-10-06T14:22:05Z" }));
expect("a date that is an instant", varied({ day: "2026-10-06T00:00:00Z" }), "day");
expect("a duration that is not ISO 8601", varied({ held: "30s" }), "held");
expect("bytes that are not base64url", varied({ token: "not base64!" }), "token");

// A decimal is a string with exactly the declared scale, because a number is a double.
expect("a decimal written as a number", varied({ total: { value: 25, currency: "SEK" } }), "total.value");
expect("a decimal at the wrong scale", varied({ total: { value: "25.0", currency: "SEK" } }), "total.value");

// The rules the model states.
expect("a range below its floor", varied({ total: { value: "-1.00", currency: "SEK" } }), "total.value");
expect(
  "a range on a value, through a list",
  varied({ items: [{ ...(base()["items"] as Record<string, unknown>[])[0], qty: 0 }] }),
  "items[0].qty",
);
expect("an exact length that is not exact", varied({ settleIn: "SEKK" }), "settleIn");
expect("a pattern that does not match", varied({ settleIn: "sek" }), "settleIn");
expect("a list shorter than `size` allows", varied({ items: [] }), "items");
expect("a repeated element where the model says `unique`", varied({ tags: ["red", "red"] }), "tags");
expect("a value that is not a member of the enum", varied({ status: "Pending" }), "status");

// `include` splices, so a rule on an included field is checked through the holder.
expect(
  "a name too long, through an include",
  varied({ items: [{ ...(base()["items"] as Record<string, unknown>[])[0], name: "x".repeat(70) }] }),
  "items[0].name",
);

// Absence, which is the half JSON gets wrong.
expect("a required field left out", varied({ orderId: undefined }), "orderId");
expect("an optional field left out is fine", base());
expect("an optional field present and wrong", varied({ note: "x".repeat(70) }), "note");
expect("a null, which 7K has none of", varied({ note: null }), "note");

// The invariants.
expect("an in-row invariant two fields break", varied({ settleIn: "NOK" }), "");
expect(
  "an invariant across a list",
  varied({
    items: [
      (base()["items"] as Record<string, unknown>[])[0],
      { name: "b", sku: "SKU-2", qty: 1, unit: { value: "1.00", currency: "NOK" } },
    ],
  }),
  "",
);

// A map's keys carry rules as much as its values do.
expect("a map key that breaks its own rule", varied({ rates: { sek: "1.05" } }), "rates.sek");
expect("a map value at the wrong scale", varied({ rates: { NOK: "1.5" } }), "rates.NOK");

// What the decoded value is, which is the whole claim.
{
  const result = decodePlaceOrder(base());
  if (!result.ok) {
    say("the decoded value is the canonical JSON it came from", false, "it did not decode");
  } else {
    const order: PlaceOrder = result.value;
    // No serializer: the branded types *are* the strings the wire carried, so a round trip is identity.
    const again = JSON.parse(JSON.stringify(order)) as unknown;
    const same = JSON.stringify(again) === JSON.stringify(base());
    say("a decoded value re-serialises to the bytes it came from", same);
    say("a decimal stays the string the contract says it is", order.total.value === ("25.00" as never));
    say("an absent optional field is absent and not null", !("note" in order));
  }
}

// A value decodes on its own, which is what makes a brand honest.
{
  const good = decodeSku("SKU-9");
  const bad = decodeSku("");
  say("a nominal value decodes on its own", good.ok && !bad.ok);
  say(
    "and a brand is not something a cast can satisfy by accident",
    !decodeCurrency("sek").ok && decodeCurrency("SEK").ok,
  );
}

console.log("");
console.log(failures === 0 ? "ALL OK" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
