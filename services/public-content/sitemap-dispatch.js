import { logIntegrationError, observeIntegrationRequest } from "../../middleware/axiom-logger.js";

const githubRepository = () => process.env.GITHUB_SITEMAP_REPOSITORY?.trim();
const githubToken = () => process.env.GITHUB_SITEMAP_DISPATCH_TOKEN?.trim();
const websiteUrl = () => process.env.SITEMAP_REVALIDATE_URL?.trim();
const websiteToken = () => process.env.SITEMAP_REVALIDATE_TOKEN?.trim();

async function revalidateWebsite(event) {
  const url = websiteUrl(), token = websiteToken();
  if (!url || !token) return false;
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("Website revalidation requires HTTPS");
    const response = await fetch(target, { method: "POST", headers: {
      "x-bgsnl-revalidate-key": token, "Content-Type": "application/json",
    }, body: JSON.stringify({ eventId: String(event.id || event._id) }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Website revalidation returned ${response.status}`);
    return true;
  } catch (error) {
    logIntegrationError("website", error, "event-revalidation");
    return false;
  }
}

/**
 * Best-effort deployment notification. The event database transaction is the
 * source of truth; a missing GitHub configuration cannot fail publishing or
 * archiving, because the sitemap's timed revalidation remains a fallback.
 */
export async function dispatchSitemapRefresh(change, event) {
  const direct = revalidateWebsite(event);
  const repository = githubRepository();
  const token = githubToken();
  if (!repository || !token) {
    const refreshed = await direct;
    if (!refreshed) logIntegrationError("github", { name: "EventRevalidationNotConfigured" }, "sitemap-dispatch");
    return refreshed;
  }

  try {
    const response = await observeIntegrationRequest("github", "sitemap-dispatch", "POST", () =>
      fetch(`https://api.github.com/repos/${repository}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "bgsnl-api-sitemap-dispatch",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: "event-sitemap-changed",
        client_payload: { change, eventId: String(event.id || event._id), slug: event.slug || null },
      }),
      signal: AbortSignal.timeout(5000),
      }));
    if (response.status !== 204) {
      logIntegrationError("github", { name: "SitemapDispatchError", status: response.status }, "sitemap-dispatch");
      return direct;
    }
    await direct;
    return true;
  } catch (error) {
    logIntegrationError("github", error, "sitemap-dispatch");
    return direct;
  }
}
