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
  const now = new Date();

  try {
    console.log("🚀 Starting Stripe Subscriptions Export...");
    console.time("Subscription Export Duration");

    let hasMore = true;
    let startingAfter = null;
    let totalSubscriptionsFetched = 0;

    while (hasMore) {
      const result = startingAfter
        ? await stripe.subscriptions.list({
            limit: 150,
            status: "canceled",
            expand: [
              "data.customer",
              "data.latest_invoice",
              "data.plan",
              "data.default_tax_rates",
              "data.default_payment_method",
            ],
            starting_after: startingAfter,
          })
        : await stripe.subscriptions.list({
            limit: 150,
            status: "canceled",
            expand: [
              "data.customer",
              "data.latest_invoice",
              "data.plan",
              "data.default_tax_rates",
            ],
          });

      const customers = result.data.map((r) => {
        return {
          id: r.customer.id,
          default_payment_method: r.default_payment_method,
        };
      });

      const formattedSubscriptions = result.data.map((subscription) => {
        const startDate = now + 26 * 60 * 60;
        const billingCycle = subscription.current_period_end || "";

        const isCanceled = billingCycle <= startDate;

        // Exactly match the columns from the billing_migration_template.csv
        return {
          customer: subscription.customer.id,
          // start at 1st dec
          start_date: startDate,
          price:
            subscription.plan.amount === 600
              ? "price_1QOg1FAShinXgMFZ1dZiQn1P"
              : "price_1QOg1XAShinXgMFZyH0F4P9i",
          quantity: subscription.quantity,
          "metadata.third_party_sub_id": subscription.id,
          automatic_tax:
            // subscription.automatic_tax ? "TRUE" :
            "FALSE",
          // when to bill the customer
          billing_cycle_anchor: isCanceled ? "" : billingCycle,
          coupon: "",
          trial_end: subscription.trial_end || "",
          proration_behavior: subscription.proration_behavior ?? "none",
          collection_method: isCanceled
            ? "send_invoice"
            : subscription.collection_method,
          default_tax_rate: subscription.default_tax_rates?.[0]?.id || "",
          backdate_start_date: subscription.current_period_start || "",
          days_until_due: isCanceled ? 3 : subscription.days_until_due || "",
          cancel_at_period_end: isCanceled
            ? "TRUE"
            : subscription.cancel_at_period_end
            ? "TRUE"
            : "FALSE",
          // "add_invoice_items.0.amount": subscription.plan.amount || "",
          // "add_invoice_items.0.product": subscription.plan.product || "",
          // "add_invoice_items.0.currency": subscription.plan.currency || "",

          // overwrite
          "add_invoice_items.0.amount": "",
          "add_invoice_items.0.product": "",
          "add_invoice_items.0.currency": "",
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
  if (process.env.APP_ENV !== "dev") {
    return;
  }

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
}

export async function cancelAllSubscriptions() {
  if (process.env.APP_ENV !== "dev") {
    return;
  }

  // add stripe client

  try {
    // Retrieve all active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      status: "active",
      limit: 100, // Adjust limit as needed
    });

    // Track cancellation results
    const cancellationResults = {
      total: subscriptions.data.length,
      cancelled: 0,
      failed: 0,
      errors: [],
    };

    // Cancel each subscription
    for (const subscription of subscriptions.data) {
      try {
        await stripe.subscriptions.cancel(subscription.id, {
          // Optional: specify reason for cancellation
          cancellation_details: {
            comment: "Bulk subscription cancellation",
          },
        });

        cancellationResults.cancelled++;

        console.log("Canceled subscription: " + subscription.id);
      } catch (cancelError) {
        cancellationResults.failed++;
        cancellationResults.errors.push({
          subscriptionId: subscription.id,
          error: cancelError.message,
        });

        console.error(
          `Failed to cancel subscription ${subscription.id}:`,
          cancelError
        );
      }
    }

    // Check if there are more subscriptions (pagination)
    let hasMore = subscriptions.has_more;
    let startingAfter = subscriptions.data[subscriptions.data.length - 1]?.id;

    while (hasMore) {
      const nextSubscriptions = await stripe.subscriptions.list({
        status: "active",
        limit: 100,
        starting_after: startingAfter,
      });

      for (const subscription of nextSubscriptions.data) {
        try {
          await stripe.subscriptions.cancel(subscription.id, {
            cancellation_details: {
              comment: "Bulk subscription cancellation",
            },
          });

          cancellationResults.cancelled++;
        } catch (cancelError) {
          cancellationResults.failed++;
          cancellationResults.errors.push({
            subscriptionId: subscription.id,
            error: cancelError.message,
          });

          console.error(
            `Failed to cancel subscription ${subscription.id}:`,
            cancelError
          );
        }
      }

      hasMore = nextSubscriptions.has_more;
      startingAfter =
        nextSubscriptions.data[nextSubscriptions.data.length - 1]?.id;
    }

    console.log("Subscription Cancelation Done");

    return cancellationResults;
  } catch (error) {
    console.error("Error retrieving subscriptions:", error);
    throw error;
  }
}

export async function recreateSubscription() {
  const stripe = createStripeClient("netherlands");

  try {
    // const subscriptions = await stripe.subscriptions.list({
    //   limit: 150,
    //   status: "canceled",
    //   expand: [
    //     "data.customer",
    //     "data.latest_invoice",
    //     "data.plan",
    //     "data.default_tax_rates",
    //   ],
    // });

    // Step 1: Check or Create the Customer
    const customerId = "cus_PyOos786fQE1E7"; // Existing customer ID
    let customer;

    // try {
    //   customer = await stripe.customers.retrieve(customerId);
    // } catch (error) {
    //    console.log("No such customer" + customerId);
    //    return
    // }

    // Step 2: Recreate the Subscription
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [
        {
          price: "price_1QOg1FAShinXgMFZ1dZiQn1P", // Original price ID
          quantity: 1,
        },
      ],
      billing_cycle_anchor: 1745591343, // Original billing cycle anchor (Unix timestamp)
      cancel_at_period_end: false, // Ensure it's an active subscription
      default_payment_method: "pm_1P8S1QIOw5UGbAo1xd9GuXov", // Original payment method
      metadata: {
        imported_from: "original_system",
      },
    });

    console.log("Subscription recreated successfully:", subscription);
  } catch (error) {
    console.error("Error recreating subscription:", error);
  }
}

async function getAllCustomers() {
  const stripe = createStripeClient("groningen");

  try {
    // Use Stripe's API to list customers (pagination may be needed for large data sets)
    let customers = [];
    let has_more = true;
    let starting_after = null;

    // while (has_more) {
    const response = await stripe.customers.list({
      limit: 300, // Max number of customers per request
    });

    customers = customers.concat(response.data);
    has_more = response.has_more;
    starting_after = response.data.length
      ? response.data[response.data.length - 1].id
      : null;
    // }

    console.log("All customers:", customers);
    return customers;
  } catch (error) {
    console.error("Error retrieving customers:", error);
  }
}

export async function updateCustomerPaymentMethods() {
  let stripe = createStripeClient("groningen");

  const result = await stripe.subscriptions.list({
    limit: 150,
    status: "canceled",
    expand: [
      "data.customer",
      "data.latest_invoice",
      "data.plan",
      "data.default_tax_rates",
      "data.default_payment_method",
      "data.customer.default_payment_method",
    ],
  });

  const customers = result.data.map((r) => {
    return {
      id: r.customer.id,
      // Extract only the payment method ID, not the entire object
      default_payment_method:
        r.default_payment_method?.id || r.default_payment_method,
    };
  });

  try {
    let stripe = createStripeClient("netherlands");

    const updatePromises = customers.map(async (customer) => {
      // Only attempt to update if a payment method ID exists
      if (customer.default_payment_method) {
        try {
          const updatedCustomer = await stripe.customers.update(customer.id, {
            invoice_settings: {
              default_payment_method: customer.default_payment_method,
            },
          });
          console.log(`Updated customer ${customer.id} successfully`);
          return updatedCustomer;
        } catch (error) {
          console.error(`Error updating customer ${customer.id}:`, error);
          return null;
        }
      }
      return null;
    });

    // Wait for all updates to complete
    const results = await Promise.all(updatePromises);

    // Filter out any failed or skipped updates
    const successfulUpdates = results.filter((result) => result !== null);

    console.log(
      `Successfully updated ${successfulUpdates.length} out of ${customers.length} customers`
    );
  } catch (error) {
    console.error("Error in update process:", error);
  }
}