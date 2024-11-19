import dotenv from "dotenv";
dotenv.config();

const webOrigins = [
  "https://bulgariansociety.netlify.app",
  "https://bulgariansociety.nl",
  "https://www.bulgariansociety.nl",
  "https://starfish-app-tvh24.ondigitalocean.app",
];

const stripeUrls = [
  "https://a.stripecdn.com",
  "https://api.stripe.com",
  "https://atlas.stripe.com",
  "https://auth.stripe.com",
  "https://b.stripecdn.com",
  "https://billing.stripe.com",
  "https://buy.stripe.com",
  "https://c.stripecdn.com",
  "https://checkout.stripe.com",
  "https://climate.stripe.com",
  "https://connect.stripe.com",
  "https://dashboard.stripe.com",
  "https://express.stripe.com",
  "https://files.stripe.com",
  "https://hooks.stripe.com",
  "https://invoice.stripe.com",
  "https://invoicedata.stripe.com",
  "https://js.stripe.com",
  "https://m.stripe.com",
  "https://m.stripe.network",
  "https://manage.stripe.com",
  "https://pay.stripe.com",
  "https://payments.stripe.com",
  "https://q.stripe.com",
  "https://qr.stripe.com",
  "https://r.stripe.com",
  "https://verify.stripe.com",
  "https://stripe.com",
  "https://terminal.stripe.com",
  "https://uploads.stripe.com",
];

const stripeIp = [
  "3.18.12.63",
  "3.130.192.231",
  "13.235.14.237",
  "13.235.122.149",
  "18.211.135.69",
  "35.154.171.200",
  "52.15.183.38",
  "54.88.130.119",
  "54.88.130.237",
  "54.187.174.169",
  "54.187.205.235",
  "54.187.216.72",
];

export const allowedOrigins = [...webOrigins, ...stripeUrls];
export const allowedIps = [...stripeIp];

export const PROTOCOL = process.env.APP_ENV === "dev" ? "http://" : "https://";

export const allowedCrawlers = [
  { name: "Googlebot", userAgent: "Googlebot", domain: ".googlebot.com" },
  { name: "Bingbot", userAgent: "bingbot", domain: ".search.msn.com" },
  { name: "Yahoo Slurp", userAgent: "Slurp", domain: ".yahoo.com" },
  { name: "DuckDuckBot", userAgent: "DuckDuckBot", domain: ".duckduckgo.com" },
  { name: "Baiduspider", userAgent: "Baiduspider", domain: ".baidu.com" },
  { name: "YandexBot", userAgent: "YandexBot", domain: ".yandex.ru" },
  { name: "Applebot", userAgent: "Applebot", domain: ".applebot.apple.com" },
  {
    name: "Facebook",
    userAgent: "facebookexternalhit",
    domain: ".facebook.com",
  },
  { name: "Twitterbot", userAgent: "Twitterbot", domain: ".twitter.com" },
  { name: "LinkedInBot", userAgent: "LinkedInBot", domain: ".linkedin.com" },
  { name: "Pinterest", userAgent: "Pinterest", domain: ".pinterest.com" },
  { name: "SemrushBot", userAgent: "SemrushBot", domain: ".semrush.com" },
];