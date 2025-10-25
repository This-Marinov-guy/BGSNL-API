import { createStripeClient } from "../config/stripe.js";
import fs from "fs";
import path from "path";
import { parse } from "json2csv";
import csv from "csv-parser";
import dotenv from "dotenv";
import { dateToUnix } from "../functions/helpers.js";
import { DEFAULT_REGION, SUBSCRIPTION_ID_BY_AMOUNT, SUBSCRIPTION_PRICE_YEAR_1 } from "../config/defines.js";
import User from "../../models/User.js";
dotenv.config();

export async function exportStripeSubscriptionsToCsv(
  outputPath = "stripe_subscriptions.csv"
) {
  if (process.env.APP_ENV !== "dev") {
    return;
  }

  const stripe = createStripeClient("groningen");
  const subscriptions = [];
  const now = dateToUnix();

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
          start_date: startDate,
          price: SUBSCRIPTION_ID_BY_AMOUNT[subscription.plan.amount] ?? SUBSCRIPTION_PRICE_YEAR_1,     
          quantity: subscription.quantity,
          "metadata.third_party_sub_id": subscription.id,
          automatic_tax:
            // subscription.automatic_tax ? "TRUE" :
            "FALSE",
          // when to bill the customer
          billing_cycle_anchor: isCanceled ? "" : billingCycle,
          coupon: "",
          trial_end: "",
          proration_behavior: "none",
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

export async function cancelAllSubscriptions() {
  if (process.env.APP_ENV !== "dev") {
    return;
  }

  // add stripe client

  try {
    // Retrieve all active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      status: "active",
      limit: 1000, // Adjust limit as needed
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
        limit: 1000,
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

export const getCustomers = async (sourceRegion) => {
  const sourceStripe = createStripeClient(sourceRegion);

  const customers = await sourceStripe.customers.list({
    limit: 1000,
    expand: ["data.default_source"],
  });

  console.log(customers);
};

export const transferBillingInfo = async (sourceRegion, targetRegion) => {
  const sourceStripe = createStripeClient(sourceRegion);
  const targetStripe = createStripeClient(targetRegion);

  let hasMore = true;
  let startingAfter = undefined;

  while (hasMore) {
    const listParams = { limit: 1000 };
    if (startingAfter) {
      listParams.starting_after = startingAfter;
    }

    const customers = await sourceStripe.customers.list(listParams);

    hasMore = customers.has_more;
    if (customers.data.length) {
      startingAfter = customers.data[customers.data.length - 1].id;
    }

    for (const customer of customers.data) {
      try {
        const billingData = {
          address: customer.address,
          shipping: customer.shipping,
          invoice_settings: customer.invoice_settings,
          tax: customer.tax,
          tax_exempt: customer.tax_exempt,
          tax_ids: customer.tax_ids,
          preferred_locales: customer.preferred_locales,
        };

        // Only include non-null fields
        const cleanBillingData = Object.entries(billingData).reduce(
          (acc, [key, value]) => {
            if (value !== null && value !== undefined) {
              acc[key] = value;
            }
            return acc;
          },
          {}
        );

        await targetStripe.customers.update(customer.id, cleanBillingData);
        console.log(`Updated billing info for customer: ${customer.email}`);
      } catch (error) {
        console.error(
          `Error updating billing for customer ${customer.email}:`,
          error.message
        );
      }
    }
  }
};

// NOTE: creates a new invoice but from today and 0 amount
export const transferPaidBillingHistory = async (
  sourceRegion,
  targetRegion
) => {
  const sourceStripe = createStripeClient(sourceRegion);
  const targetStripe = createStripeClient(targetRegion);

  let hasMore = true;
  let startingAfter = undefined;

  while (hasMore) {
    const listParams = {
      limit: 1000,
      expand: ["data.subscription"], // Include subscription details
    };
    if (startingAfter) {
      listParams.starting_after = startingAfter;
    }

    const customers = await sourceStripe.customers.list(listParams);

    hasMore = customers.has_more;
    if (customers.data.length) {
      startingAfter = customers.data[customers.data.length - 1].id;
    }

    for (const customer of customers.data) {
      // Vladislav Marinov customer id
      if (customer.id !== "cus_QmDY394aMHCuGb") {
        continue;
      }

      try {
        let invHasMore = true;
        let invStartingAfter = undefined;

        while (invHasMore) {
          const invListParams = {
            customer: customer.id,
            limit: 100,
            status: "paid",
          };
          if (invStartingAfter) {
            invListParams.starting_after = invStartingAfter;
          }

          const invoices = await sourceStripe.invoices.list(invListParams);

          invHasMore = invoices.has_more;
          if (invoices.data.length) {
            invStartingAfter = invoices.data[invoices.data.length - 1].id;
          }

          for (const invoice of invoices.data) {
            // Fetch subscription details
            const subscription = await sourceStripe.subscriptions.retrieve(
              invoice.subscription
            );

            // console.log(invoice);

            // return console.log(subscription);

            if (invoice?.subscription === undefined) {
              continue;
            }

            const invoiceData = {
              customer: customer.id,
              collection_method: invoice.collection_method,
              currency: invoice.currency,
              auto_advance: false,
              application_fee_amount: invoice.amount_paid,
              effective_at: invoice.created,
              metadata: {
                original_invoice_id: invoice.id,
                original_subscription_id: invoice.subscription,
                subscription_period_start: subscription.current_period_start,
                subscription_period_end: subscription.current_period_end,
                subscription_status: subscription.status,
                original_amount_paid: invoice.amount_paid,
                original_paid_at: invoice.status_transitions?.paid_at,
              },
            };

            // Add subscription description
            invoiceData.description = `Subscription payment for period: ${new Date(
              subscription.current_period_start * 1000
            ).toLocaleDateString()} to ${new Date(
              subscription.current_period_end * 1000
            ).toLocaleDateString()}`;

            // Get and create invoice items with subscription details
            const items = await sourceStripe.invoiceItems.list({
              invoice: invoice.id,
            });

            // Create the invoice
            const newInvoice = await targetStripe.invoices.create(invoiceData);

            // Add invoice items
            for (const item of items.data) {
              const itemData = {
                customer: customer.id,
                invoice: newInvoice.id,
                amount: item.amount,
                currency: item.currency,
                description: `${
                  item.description ||
                  subscription.plan.nickname ||
                  "Subscription payment"
                } (${new Date(
                  subscription.current_period_start * 1000
                ).toLocaleDateString()})`,
              };

              if (item.price) itemData.price = item.price;
              if (item.quantity) itemData.quantity = item.quantity;

              await targetStripe.invoiceItems.create(itemData);
            }

            // Finalize and mark as paid
            await targetStripe.invoices.finalizeInvoice(newInvoice.id);
            // await targetStripe.invoices.pay(newInvoice.id, {
            //   paid_out_of_band: true,
            // });

            console.log(
              `Transferred subscription invoice ${invoice.id} for customer: ${customer.email}`
            );
          }
        }

        console.log(
          `Completed subscription billing history transfer for customer: ${customer.email}`
        );
      } catch (error) {
        console.error(
          `Error transferring subscription history for customer ${customer.email}:`,
          error.message
        );
      }
    }
  }
};

// TODO: update for alumnis as well
export async function migratedSubscriptionsDBupdate() {
  const stripe = createStripeClient(DEFAULT_REGION);
  let updated = 0;

  try {
    let hasMore = true;
    let startingAfter = null;
    const subscriptions = [];

    while (hasMore) {
      const result = startingAfter
        ? await stripe.subscriptions.list({
            limit: 200,
            // expand: [
            //   "data.customer",
            //   "data.latest_invoice",
            //   "data.plan",
            //   "data.default_tax_rates",
            //   "data.default_payment_method",
            // ],
            starting_after: startingAfter,
          })
        : await stripe.subscriptions.list({
            limit: 150,
            // expand: [
            //   "data.customer",
            //   "data.latest_invoice",
            //   "data.plan",
            //   "data.default_tax_rates",
            // ],
          });

      subscriptions.push(...result.data);

      // Check if there are more subscriptions to retrieve
      hasMore = result.has_more;
      if (hasMore) {
        startingAfter = result.data[result.data.length - 1].id;
      }
    }

    for (const sub of subscriptions) {
      if (!sub?.metadata?.third_party_sub_id) {
        console.log("User is not migratable");
        continue;
      }

      let user;

      try {
        user = await User.findOne({
          "subscription.id": sub?.metadata?.third_party_sub_id,
        });
      } catch (err) {
        console.error("Error fetching user:", err);
        continue;
      }

      if (!user?.subscription?.id) {
        console.log(
          "User not found for subscription:",
          sub?.metadata?.third_party_sub_id
        );
        continue;
      }

      user.subscription.id = sub.id;

      try {
        await user.save();
        console.log("User updated:", sub.id);
        updated++;
      } catch (err) {
        console.log("User was not updated", sub.id, err);
      }
    }
  } catch (error) {
    console.error("Error fetching subscriptions:", error);
    throw error;
  }

  console.log("Done", updated);
}
