/**
 * Does the generated development host actually run a handler inside a 7K Sandbox scenario?
 *
 * `behaviour.ts` proves the decoders decode. This proves the thing built on top of them: that a
 * plainly-written implementation of a generated interface can be dropped into a scenario, that the
 * scenario delivers to it, and that what it receives is decoded rather than cast.
 *
 * ### Compiling is half the proof
 *
 * The first thing below assigns a generated adapter to `@sevenk/sandbox`'s own `Handler` type. That
 * assignment is the whole claim of the co-location argument: generated code names none of the
 * sandbox's types and imports nothing from it, and TypeScript accepts it as a `Handler` anyway
 * because the two shapes agree. If the sandbox's handler contract ever moves, this file stops
 * compiling — which is the point of writing the claim down as an assignment rather than as a comment.
 *
 * Nothing else in the generated output refers to the sandbox, and nothing may: a consumer has to be
 * able to build this without taking a dependency on a test harness. The coupling test in
 * `test/coupling.test.ts` holds the provider to that; this file is the other half, where the two are
 * deliberately brought together and the structural fit is checked.
 *
 * ### Running it is the other half
 *
 * Then a scenario runs with `Desk` live and everything else mocked, and the implementation records
 * what it was handed. A compiled adapter that threw on every delivery would pass the first half.
 */

import { readFileSync } from "node:fs";
import { buildWorkspace } from "@sevenk/core";
import { runScenario, type Handler } from "@sevenk/sandbox";
import {
  deskDevHost,
  warehouseDevHost,
  type Desk,
  type Done,
  type PlaceOrder,
  type PlaceOrderOutcome,
  type Ship,
  type Shipped,
  type Trace,
  type Warehouse,
} from "./model.js";

let failures = 0;

const say = (what: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};

/* ------------------------------------------------- the implementations, written by hand */

/**
 * A `Desk`, written the way somebody would write one.
 *
 * It knows nothing about the sandbox, nothing about decoding, and nothing about this file. The
 * generated interface is its only contact with 7K — which is the arrangement the whole dev host
 * exists to make possible.
 */
class RecordingDesk implements Desk {
  readonly orders: PlaceOrder[] = [];
  readonly traces: Trace[] = [];

  async handlePlaceOrder(message: PlaceOrder, trace: Trace): Promise<PlaceOrderOutcome> {
    this.orders.push(message);
    this.traces.push(trace);
    // A branded field used as what it is. Nothing casts to get here.
    const done: Done = { orderId: message.orderId };
    return { kind: "Done", message: done };
  }

  async handleCharged(): Promise<void> {}
  async handleShipped(): Promise<void> {}
  async handleNoted(): Promise<void> {}
}

/** A `Warehouse`, which is the single-reply shape: the method returns the reply itself. */
class CountingWarehouse implements Warehouse {
  ships = 0;

  async handleShip(message: Ship): Promise<Shipped> {
    this.ships++;
    return { orderId: message.orderId };
  }
}

/* ------------------------------------------------------ 1. the structural claim, at compile time */

// The assignment *is* the test. `tsc` runs over this file in `scripts/verify.mjs`, so a shape that
// no longer fits the sandbox's `Handler` fails the build rather than the run.
const asHandler: Handler = deskDevHost(new RecordingDesk());
const alsoAHandler: Handler = warehouseDevHost(new CountingWarehouse());
say("a generated dev host is a sandbox `Handler`, structurally", typeof asHandler === "function");
say("so is one whose subscription declares a single reply", typeof alsoAHandler === "function");

/* ------------------------------------------------------------------------ 2. inside a scenario */

const MODEL = readFileSync("verify/model/shop.7k", "utf8");

const ORDER = "11111111-1111-1111-1111-111111111111";

const BODY = `{
      orderId:  "${ORDER}",
      items:    { $repeat: 2, of: { name: "a line", sku: "SKU-1", qty: 2, unit: { value: "12.50", currency: "SEK" } } },
      total:    { value: "25.00", currency: "SEK" },
      tags:     ["red", "blue"],
      rates:    { NOK: "1.05" },
      status:   Open,
      token:    "AQID",
      stamped:  "2026-01-01T00:00:00Z",
      held:     "30s",
      day:      "2026-01-01",
      settleIn: "SEK",
      weight:   1.5,
      count:    7
    }`;

const SCENARIO = `scenarios for shop

scenario DevHost {
  seed 7

  at 0s publish PlaceOrder as Front
    with envelope { priority: 3 }
    ${BODY}

  advance 1s
  expect Desk handled PlaceOrder count 1
  expect Done on inbound
}

scenario OneReply {
  seed 7

  at 0s publish Ship as Desk { orderId: "${ORDER}" }

  advance 1s
  expect Shipped on inbound
}
`;

const workspace = buildWorkspace([
  { path: "shop.7k", source: MODEL },
  { path: "shop.scenario.7k", source: SCENARIO },
]);

const broken = workspace.diagnostics.filter((d) => d.severity === "error");
if (broken.length > 0) {
  for (const d of broken) console.log(`FAIL  the fixture does not check out: ${d.message}`);
  process.exit(2);
}

const file = workspace.scenarios[0];
if (file === undefined) {
  console.log("FAIL  no scenario file was parsed");
  process.exit(2);
}

const scenarioNamed = (name: string) => {
  const found = file.scenarios.find((s) => s.name === name);
  if (found === undefined) throw new Error(`the fixture declares no scenario \`${name}\``);
  return found;
};

{
  const desk = new RecordingDesk();
  const result = await runScenario(workspace.model, file, scenarioNamed("DevHost"), {
    // The qualified name, because two packages may each declare a `Desk` and the bare one would then
    // be a guess. The sandbox accepts either; generated code says this.
    live: new Map([["shop.Desk", deskDevHost(desk)]]),
  });

  const failed = result.assertions.filter((a) => a.status !== "pass");
  say(
    "a scenario delivers to the live handler and judges its reply",
    result.status === "pass",
    failed.map((a) => `${a.text}: ${a.detail ?? "(no detail)"}`).join("; ") ||
      result.errors.join("; "),
  );

  const order = desk.orders[0];
  say("the implementation was called exactly once", desk.orders.length === 1);

  // The shape the interface promises, all the way down: the list the `$repeat` directive generated
  // arrived as a list of records, the decimal is still the string the contract says it is, and the
  // float is a number. That it was *decoded* rather than cast is what the direct calls below settle
  // — a cast would satisfy every assertion here.
  say(
    "what the implementation receives is the shape its interface declares",
    order !== undefined &&
      order.items.length === 2 &&
      order.items[0]?.sku === "SKU-1" &&
      order.total.value === "25.00" &&
      order.weight === 1.5 &&
      !("note" in order) &&
      !("everyFifth" in order),
    JSON.stringify(order),
  );

  say(
    "the envelope arrived decoded too, out of the one flattened map (D50)",
    desk.traces[0]?.priority === 3 && /^[0-9a-f-]{36}$/.test(desk.traces[0]?.correlationId ?? ""),
    JSON.stringify(desk.traces[0]),
  );
}

{
  const warehouse = new CountingWarehouse();
  const result = await runScenario(workspace.model, file, scenarioNamed("OneReply"), {
    live: new Map([["shop.Warehouse", warehouseDevHost(warehouse)]]),
  });

  const failed = result.assertions.filter((a) => a.status !== "pass");
  say(
    "a subscription with one declared reply returns it directly",
    result.status === "pass" && warehouse.ships === 1,
    failed.map((a) => `${a.text}: ${a.detail ?? "(no detail)"}`).join("; ") ||
      result.errors.join("; "),
  );
}

/* ------------------------------------- 3. what the adapter does that a scenario cannot provoke */

/** A `PlaceOrder` body that satisfies every rule, as a value rather than as 7K literal text. */
const valid = (): Record<string, unknown> => ({
  orderId: ORDER,
  items: [{ name: "a line", sku: "SKU-1", qty: 2, unit: { value: "12.50", currency: "SEK" } }],
  total: { value: "12.50", currency: "SEK" },
  tags: ["red"],
  rates: { NOK: "1.05" },
  status: "Open",
  token: "AQID",
  stamped: "2026-01-01T00:00:00Z",
  held: "30s",
  day: "2026-01-01",
  settleIn: "SEK",
  weight: 1.5,
  count: 7,
});

/**
 * A delivery the engine will not make, handed to the adapter directly.
 *
 * The engine validates a payload on receipt and dead-letters an invalid one, so none of these can
 * arrive through a scenario — and each is an arm of the generated code that would otherwise never be
 * run. So they are called here, which is the only place they are reachable. That the call compiles
 * at all is the structural claim again, from the other side: this file builds the delivery itself and
 * the adapter accepts it.
 */
const deliver = async (
  type: string,
  body: Record<string, unknown>,
  desk = new RecordingDesk(),
): Promise<string> => {
  try {
    await deskDevHost(desk)({
      envelope: { type, version: "1.0", fields: { priority: 3, correlationId: ORDER } },
      body,
    });
    return "(it returned)";
  } catch (failure) {
    return failure instanceof Error ? failure.message : String(failure);
  }
};

{
  // The claim the whole decode-rather-than-cast argument rests on, from the one direction a cast
  // cannot fake: the decoder builds a fresh value out of the declared fields, so a field nobody
  // declared is not in what the implementation receives. A cast would have passed `extra` straight
  // through, because a cast changes nothing but the type.
  const desk = new RecordingDesk();
  await deliver("shop.PlaceOrder", { ...valid(), extra: "not a declared field" }, desk);
  const order = desk.orders[0];
  say(
    "the body is decoded rather than cast, so an undeclared field is not passed along",
    order !== undefined && !("extra" in order) && order.items.length === 1,
    JSON.stringify(order),
  );
}

{
  const said = await deliver("shop.PlaceOrder", { orderId: "not-a-uuid" });
  // And the other direction: a body that does not satisfy the contract never reaches the
  // implementation, and what comes back names the field.
  say(
    "a body that does not decode is refused rather than handed over",
    said.includes("did not decode") && said.includes("orderId"),
    said,
  );
}

{
  const said = await deliver("shop.Refund", { orderId: ORDER, authId: ORDER });
  // `Refund` is a message `Desk` emits and never reacts to, so routing one here is a fault in
  // whatever did the routing. Returning nothing would acknowledge it.
  say(
    "a message the service does not react to is thrown rather than acknowledged",
    said.includes("does not react to") && said.includes("shop.Refund"),
    said,
  );
}

console.log("");
console.log(failures === 0 ? "ALL OK" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
