import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Stripe from "stripe";

const apiDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const websiteDirectory = path.resolve(apiDirectory, "../BGSNL");
const apiEnv = dotenv.parse(await readFile(path.join(apiDirectory, ".env.dev")));
const key = apiEnv.STRIPE_SECRET_KEY_TEST || apiEnv.STRIPE_NL_SECRET_KEY;
if (!/^sk_test_[A-Za-z0-9]+$/.test(key || "")) {
  throw new Error("E2E price setup requires the configured Stripe test secret key.");
}
const stripe = new Stripe(key);
const definitions = [
  ["MEMBERSHIP_6M", 600, 6, "Member, six months"],
  ["MEMBERSHIP_12M", 1000, 12, "Member, twelve months"],
  ["ALUMNI_TIER_1", 300, 1, "Alumni, tier one"],
  ["ALUMNI_TIER_2", 500, 1, "Alumni, tier two"],
  ["ALUMNI_TIER_3", 700, 1, "Alumni, tier three"],
  ["ALUMNI_TIER_4", 1000, 1, "Alumni, tier four"],
];

const lines = [];
for (const [name, cents, months, nickname] of definitions) {
  // Stripe Billing Portal accepts one price per billing interval for each
  // product. Alumni tiers all renew monthly, so each needs its own product.
  const existingProducts = await stripe.products.search({ query: `metadata['bgsnl_e2e_plan']:'${name}'`, limit: 1 });
  const product = existingProducts.data[0] || await stripe.products.create({
    name: `BGSNL UI journey ${nickname}`,
    metadata: { bgsnl_e2e_suite: "ui-journeys", bgsnl_e2e_plan: name },
  }, { idempotencyKey: `bgsnl-ui-journeys-product-${name.toLowerCase()}-v2` });
  const lookup = `bgsnl_ui_journeys_${name.toLowerCase()}_v2`;
  const found = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 });
  const price = found.data[0] || await stripe.prices.create({
    product: product.id,
    currency: "eur",
    unit_amount: cents,
    recurring: { interval: "month", interval_count: months },
    nickname,
    lookup_key: lookup,
    metadata: { bgsnl_e2e_suite: "ui-journeys" },
  }, { idempotencyKey: `bgsnl-ui-journeys-${name.toLowerCase()}-v2` });
  if (price.product !== product.id || price.unit_amount !== cents || price.recurring?.interval !== "month" || price.recurring.interval_count !== months) {
    throw new Error(`Existing test price ${name} has unexpected terms.`);
  }
  lines.push(`STRIPE_${name}_PRICE_ID=${price.id}`);
  lines.push(`NEXT_PUBLIC_STRIPE_${name}_PRICE_ID=${price.id}`);
}
await writeFile(path.join(websiteDirectory, ".env.e2e.local"), `${lines.join("\n")}\n`, { mode: 0o600 });
console.log("Six recurring Stripe test prices are ready in BGSNL/.env.e2e.local.");
