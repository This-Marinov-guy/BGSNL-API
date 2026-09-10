const githubRepository = () => process.env.GITHUB_SITEMAP_REPOSITORY?.trim();
const githubToken = () => process.env.GITHUB_SITEMAP_DISPATCH_TOKEN?.trim();

/**
 * Best-effort deployment notification. The event database transaction is the
 * source of truth; a missing GitHub configuration cannot fail publishing or
 * archiving, because the sitemap's timed revalidation remains a fallback.
 */
export async function dispatchSitemapRefresh(change, event) {
  const repository = githubRepository();
  const token = githubToken();
  if (!repository || !token) return false;

  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/dispatches`, {
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
    });
    return response.status === 204;
  } catch {
    return false;
  }
}
