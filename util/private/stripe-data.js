import { createStripeClient } from "../config/stripe.js";
import fs from "fs";
import path from "path";
import { parse } from "json2csv";
import csv from "csv-parser";
import dotenv from "dotenv";
dotenv.config();

export async function exportStripeSubscriptionsToCsv(
  outputPath = "stripe_subscriptions.csv"
) {
  if (process.env.APP_ENV !== "dev") {
    return;
  }

  const stripe = createStripeClient("groningen");
  const subscriptions = [];

  try {
    console.log("🚀 Starting Stripe Subscriptions Export...");
    console.time("Subscription Export Duration");

    let hasMore = true;
    let startingAfter = null;
    let totalSubscriptionsFetched = 0;

    while (hasMore) {
      const result = startingAfter
        ? await stripe.subscriptions.list({
            limit: 100,
            expand: [
              "data.customer",
              "data.latest_invoice",
              "data.plan",
              "data.default_tax_rates",
            ],
            starting_after: startingAfter,
          })
        : await stripe.subscriptions.list({
            limit: 100,
            expand: [
              "data.customer",
              "data.latest_invoice",
              "data.plan",
              "data.default_tax_rates",
            ],
          });

      const formattedSubscriptions = result.data.map((subscription) => {
        // Exactly match the columns from the billing_migration_template.csv
        return {
          customer: subscription.customer.id,
          // start at 1st dec
          start_date: 1733011200 + 24 * 60 * 60,
          price:
            subscription.plan.amount === 600
              ? "price_1QOg1FAShinXgMFZ1dZiQn1P"
              : "price_1QOg1XAShinXgMFZyH0F4P9i",
          quantity: subscription.quantity,
          "metadata.third_party_sub_id": subscription.id,
          automatic_tax:
            // subscription.automatic_tax ? "TRUE" :
            "FALSE",
          billing_cycle_anchor: 1733011200 + 25 * 60 * 60,
          coupon: "",
          trial_end: subscription.trial_end || "",
          proration_behavior: subscription.proration_behavior ?? "none",
          collection_method: subscription.collection_method,
          default_tax_rate: subscription.default_tax_rates?.[0]?.id || "",
          backdate_start_date: subscription.backdate_start_date || "",
          days_until_due: subscription.days_until_due || "",
          cancel_at_period_end: subscription.cancel_at_period_end
            ? "TRUE"
            : "FALSE",
          // "add_invoice_items.0.amount": subscription.plan.amount || "",
          // "add_invoice_items.0.product": subscription.plan.product || "",
          // "add_invoice_items.0.currency": subscription.plan.currency || "",

          // overwrite
          "add_invoice_items.0.amount": subscription.plan.amount || "",
          "add_invoice_items.0.product": "prod_RHEU16P5ALJjPi",
          "add_invoice_items.0.currency": subscription.plan.currency || "",
        };
      });

      subscriptions.push(...formattedSubscriptions);
      totalSubscriptionsFetched += formattedSubscriptions.length;

      // Check if there are more subscriptions to retrieve
      hasMore = result.has_more;
      if (hasMore) {
        startingAfter = result.data[result.data.length - 1].id;
      }
    }

    // Resolve to absolute path
    let resolvedPath = path.resolve(process.cwd(), outputPath);

    // Ensure directory exists and path is a file, not a directory
    const directory = path.dirname(resolvedPath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    // Check if resolved path is a directory
    const stats = fs.statSync(directory);
    if (stats.isDirectory()) {
      // If it's a directory, append a default filename if needed
      resolvedPath = path.join(
        directory,
        "/util/files/stripe_subscriptions.csv"
      );
    }

    // Convert to CSV
    const csv = parse(subscriptions, {
      fields: [
        "customer",
        "start_date",
        "price",
        "quantity",
        "metadata.third_party_sub_id",
        "automatic_tax",
        "billing_cycle_anchor",
        "coupon",
        "trial_end",
        "proration_behavior",
        "collection_method",
        "default_tax_rate",
        "backdate_start_date",
        "days_until_due",
        "cancel_at_period_end",
        "add_invoice_items.0.amount",
        "add_invoice_items.0.product",
        "add_invoice_items.0.currency",
      ],
    });

    // Write to file
    fs.writeFileSync(resolvedPath, csv);

    console.timeEnd("Subscription Export Duration");
    console.log(
      `✅ Export completed! Total Subscriptions: ${totalSubscriptionsFetched}`
    );
    console.log(`📁 CSV saved to: ${resolvedPath}`);

    return {
      totalSubscriptions: totalSubscriptionsFetched,
      outputPath: resolvedPath,
    };
  } catch (error) {
    console.error("❌ Error exporting Stripe subscriptions:", error);
    throw error;
  }
}

export async function importCustomers(
  file = "unified_customers-1.csv",
  region = "netherlands"
) {
  const stripe = createStripeClient(region);

  const customers = [];

  fs.createReadStream(path.resolve("util/files/" + file))
    .pipe(csv())
    .on("data", (row) => {
      if (row.Email) {
        const customerData = {
          id: row.id || undefined,
          email: row.Email,
          name: row.Name || "",
          description: row.Description || "",
          // created: row["Created (UTC)"]
          //   ? new Date(row["Created (UTC)"])
          //   : undefined,
          metadata: {
            delinquent: row.Delinquent || "false",
            card_id: row["Card ID"] || "",
            card_name: row["Card Name"] || "",
            total_spend: row["Total Spend"] || "0",
            payment_count: row["Payment Count"] || "0",
            average_order: row["Average Order"] || "0",
            account_balance: row["Account Balance"] || "0",
            currency: row.Currency || "",
            plan: row.Plan || "",
            status: row.Status || "",
            cancel_at_period_end: row["Cancel At Period End"] || "false",
          },
          address: {
            line1: row["Card Address Line1"] || "",
            line2: row["Card Address Line2"] || "",
            city: row["Card Address City"] || "",
            state: row["Card Address State"] || "",
            country: row["Card Address Country"] || "",
            postal_code: row["Card Address Zip"] || "",
          },
          shipping: {
            name: row.Name || "",
            address: {
              line1: row["Card Address Line1"] || "",
              line2: row["Card Address Line2"] || "",
              city: row["Card Address City"] || "",
              state: row["Card Address State"] || "",
              country: row["Card Address Country"] || "",
              postal_code: row["Card Address Zip"] || "",
            },
          },
        };

        customers.push(customerData);
      }
    })
    .on("end", async () => {
      for (const customer of customers) {
        try {
          await stripe.customers.create(customer);
          console.log(`Imported: ${customer.email}`);
        } catch (error) {
          console.error(`Error importing ${customer.email}:`, error);
        }
      }
    });
};