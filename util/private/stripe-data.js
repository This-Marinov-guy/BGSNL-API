import { createStripeClient } from "../config/stripe.js";
import fs from "fs";
import path from "path";
import { parse } from "json2csv";
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
        console.log(subscription);
        
        // Exactly match the columns from the billing_migration_template.csv
        return {
          customer: subscription.customer.id,
          start_date: subscription.start_date,
          price: subscription.plan.id,
          quantity: subscription.quantity,
          "metadata.third_party_sub_id":
            subscription.id,
          automatic_tax: subscription.automatic_tax ? "TRUE" : "FALSE",
          billing_cycle_anchor: subscription.billing_cycle_anchor,
          coupon: subscription.discount?.coupon?.id || "",
          trial_end: subscription.trial_end || "",
          proration_behavior: subscription.proration_behavior,
          collection_method: subscription.collection_method,
          default_tax_rate: subscription.default_tax_rates?.[0]?.id || "",
          backdate_start_date: subscription.backdate_start_date || "",
          days_until_due: subscription.days_until_due || "",
          cancel_at_period_end: subscription.cancel_at_period_end
            ? "TRUE"
            : "FALSE",
          "add_invoice_items.0.amount":
            subscription.add_invoice_items?.[0]?.amount || "",
          "add_invoice_items.0.product":
            subscription.add_invoice_items?.[0]?.product || "",
          "add_invoice_items.0.currency":
            subscription.add_invoice_items?.[0]?.currency || "",
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

    // // Resolve to absolute path
    // let resolvedPath = path.resolve(process.cwd(), outputPath);

    // // Ensure directory exists and path is a file, not a directory
    // const directory = path.dirname(resolvedPath);
    // if (!fs.existsSync(directory)) {
    //   fs.mkdirSync(directory, { recursive: true });
    // }

    // // Check if resolved path is a directory
    // const stats = fs.statSync(directory);
    // if (stats.isDirectory()) {
    //   // If it's a directory, append a default filename if needed
    //   resolvedPath = path.join(directory, "files/stripe_subscriptions.csv");
    // }

    // // Convert to CSV
    // const csv = parse(subscriptions, {
    //   fields: [
    //     "customer",
    //     "start_date",
    //     "price",
    //     "quantity",
    //     "metadata.third_party_sub_id",
    //     "automatic_tax",
    //     "billing_cycle_anchor",
    //     "coupon",
    //     "trial_end",
    //     "proration_behavior",
    //     "collection_method",
    //     "default_tax_rate",
    //     "backdate_start_date",
    //     "days_until_due",
    //     "cancel_at_period_end",
    //     "add_invoice_items.0.amount",
    //     "add_invoice_items.0.product",
    //     "add_invoice_items.0.currency",
    //   ],
    // });

    // // Write to file
    // fs.writeFileSync(resolvedPath, csv);

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
