import axios from "axios";
import AlumniUser from "../../models/AlumniUser.js";
import Event from "../../models/Event.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { loadWeeklyMembershipSummary } from "../background-services/weekly-membership-report.js";
import { readSpreadsheetRows } from "../background-services/google-spreadsheets.js";
import { eventPageUrl } from "../events/member-event-links.js";
import { removeBgPosts } from "../side-services/integration/wordpress-service.js";
import { ARTICLES_SHEET } from "../../util/config/SPREEDSHEATS.js";
import { isActiveSummaryAlumni, monthlyPeriod, normalizeSummaryEmail, safeHttpsUrl } from "./policy.js";

const plainArticleText = value => String(value || "").replace(/<[^>]*>/g, " ")
  .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] || "";
  }).replace(/\s+/g, " ").trim();

const articleSlug = title => title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "article";

export async function loadMonthlyArticles(period, {
  blogId = process.env.WORDPRESS_BLOG_ID,
  fetchPage = async ({ blogId, after, before, page }) => (await axios.get(
    `https://public-api.wordpress.com/wp/v2/sites/${encodeURIComponent(blogId)}/posts`,
    { params: { after, before, page, per_page: 100, _fields: "id,date_gmt,title,excerpt,content" }, timeout: 10000 },
  )).data,
  loadTranslations = () => readSpreadsheetRows(ARTICLES_SHEET, "Translations", "B2", "C1000"),
} = {}) {
  if (!blogId) return [];
  const after = new Date(+period.periodStart - 86400000).toISOString();
  const before = new Date(+period.cutoff + 86400000).toISOString();
  const posts = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await fetchPage({ blogId, after, before, page });
    if (!Array.isArray(batch)) throw new Error("WordPress did not return an article list.");
    posts.push(...batch);
    if (batch.length < 100) break;
    if (page === 10) throw new Error("WordPress returned more than 1,000 articles for one month.");
  }
  if (!posts.length) return [];
  const translationIds = await loadTranslations();
  return removeBgPosts(posts, translationIds).filter(post => {
    const published = new Date(`${post.date_gmt || ""}Z`);
    return Number.isFinite(+published) && +published >= +period.periodStart && +published < +period.cutoff;
  }).map(post => {
    const title = plainArticleText(post.title?.rendered);
    const description = plainArticleText(post.excerpt?.rendered).slice(0, 240);
    const image = safeHttpsUrl((/<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(post.content?.rendered || "")?.[1] || "").replaceAll("&amp;", "&"));
    return { title, description, image,
      url: `https://www.bulgariansociety.nl/articles/${encodeURIComponent(post.id)}/${articleSlug(title)}` };
  }).filter(article => article.title);
}

export async function loadMonthlySnapshot(month, { now = new Date(), EventModel = Event,
  loadCounts = loadWeeklyMembershipSummary, loadArticles = loadMonthlyArticles } = {}) {
  const period = monthlyPeriod(month, now);
  const actualDate = { $ifNull: ["$correctedDate", "$date"] };
  const [events, counts, articles] = await Promise.all([
    EventModel.find({ hidden: { $ne: true }, status: { $nin: ["draft", "cancelled", "canceled"] },
      $expr: { $and: [{ $gte: [actualDate, period.periodStart] }, { $lt: [actualDate, period.cutoff] }] },
    }).select("_id title date correctedDate poster region slug guestList.refunded").maxTimeMS(15000).lean(),
    loadCounts({ periodStart: period.periodStart, periodEnd: period.cutoff }),
    Promise.resolve().then(() => loadArticles(period))
      .catch(error => { logOperationalError("monthly-summary.articles", error); return []; }),
  ]);
  return { month, label: period.label, cutoff: period.cutoff.toISOString(),
    members: counts.totals.members, alumni: counts.totals.alumni,
    ticketsSold: events.reduce((total, event) => total + (event.guestList || []).filter(ticket => ticket.refunded !== true).length, 0),
    articles, news: [],
    events: events.map(event => ({ id: String(event._id), title: event.title,
      date: new Date(event.correctedDate || event.date).toISOString(), poster: safeHttpsUrl(event.poster), url: eventPageUrl(event),
    })).sort((left, right) => left.date.localeCompare(right.date)),
  };
}

export async function loadMonthlyRecipients({ now = new Date(), internalEmails = [], AlumniModel = AlumniUser } = {}) {
  const accounts = await AlumniModel.find({ status: "active", tier: { $gte: 1, $lte: 4 }, notificationTerms: true,
    $or: [{ expireDate: { $gt: now } }, { roles: "vip" }],
  }).select("_id email status tier expireDate roles subscription.id subscription.hasBenefits subscription.lockReason notificationTerms notificationTypeTerms").maxTimeMS(15000).lean();
  const emails = new Set(accounts.filter(account => isActiveSummaryAlumni(account, now)).map(account => normalizeSummaryEmail(account.email)));
  const alumniCount = emails.size;
  for (const value of internalEmails) { const email = normalizeSummaryEmail(value); if (email) emails.add(email); }
  return { emails: [...emails], alumniCount, internalCount: emails.size - alumniCount };
}
