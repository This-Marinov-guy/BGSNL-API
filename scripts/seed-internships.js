/**
 * Seed script: uploads internship logos to S3 BUCKET_DOCUMENTS and creates
 * Internship documents in MongoDB from the static INTERNSHIPS_LIST.
 *
 * Usage:
 *   node scripts/seed-internships.js
 *   node scripts/seed-internships.js --apply        (actually write to DB/S3)
 *   node scripts/seed-internships.js --env-file=.env.prod --apply
 *
 * By default runs in dry-run mode (no writes). Pass --apply to commit.
 */

import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import https from "https";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse args before dotenv so we can pick the right env file
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFile = envFileArg
  ? path.resolve(__dirname, "..", envFileArg.split("=")[1])
  : path.resolve(__dirname, "..", ".env");

import dotenv from "dotenv";
dotenv.config({ path: envFile });

import AWS from "aws-sdk";
import mongoose from "mongoose";
import Internship from "../models/Internship.js";

// ── Static internship data ─────────────────────────────────────────────────
// Copied verbatim from BGSNL/src/util/defines/INTERNSHIPS.js
const INTERNSHIPS_LIST = [
  {
    id: 17,
    logo: "https://ilike.media/wp-content/uploads/2022/04/Logo-Black-200x50-1.png",
    company: "iLike Media",
    specialty: "Creative media internship",
    location: "Remote",
    label: "International & Remote",
    duration: "Flexible",
    description:
      "A creative media production internship focused on social media, content creation, and the development of engaging media campaigns across digital platforms.",
    bonuses:
      "Hands-on experience in digital media production, portfolio building opportunities, creative freedom, networking with industry professionals",
    requirements:
      "Creative mindset, interest in social media and content creation, storytelling skills, video production and AI skills",
    languages: "English",
    contactMail: "",
    website: "https://ilikemedia.nl/",
  },
  {
    id: 18,
    logo: "https://ilike.media/wp-content/uploads/2022/04/Logo-Black-200x50-1.png",
    company: "iLike Media",
    specialty: "Real Estate & Location Analysis",
    location: "Remote",
    label: "International & Remote",
    duration: "Flexible",
    description:
      "An internship focused on real estate studies, urban planning, and spatial geography. Work on location assessment, zoning analysis, and feasibility studies for various projects.",
    bonuses:
      "Hands-on experience in real estate analysis, portfolio building opportunities, creative freedom, networking with industry professionals",
    requirements:
      "Background in Real Estate Studies, Urban Planning, Economics, or Spatial Geography. Skills in location assessment, zoning analysis, and feasibility studies.",
    languages: "English",
    contactMail: "",
    website: "https://ilikemedia.nl/",
  },
  {
    id: 19,
    logo: "https://ilike.media/wp-content/uploads/2022/04/Logo-Black-200x50-1.png",
    company: "iLike Media",
    specialty: "Architecture & Building Design",
    location: "Remote",
    label: "International & Remote",
    duration: "Flexible",
    description:
      "An internship in architecture and building design focusing on 3D modelling, urban design, and sustainable building concepts. Ideal for architecture students from TU/e, TU Delft, or Industrial Design programs.",
    bonuses:
      "Hands-on experience in architectural design, portfolio building opportunities, creative freedom, networking with industry professionals",
    requirements:
      "Background in Architecture or Industrial Design. Skills in 3D modelling, urban design, and sustainable building concepts.",
    languages: "English",
    contactMail: "",
    website: "https://ilikemedia.nl/",
  },
  {
    id: 20,
    logo: "https://ilike.media/wp-content/uploads/2022/04/Logo-Black-200x50-1.png",
    company: "iLike Media",
    specialty: "Trade Fair Development & Sales",
    location: "Remote",
    label: "International & Remote",
    duration: "Flexible",
    description:
      "An internship in trade fair development and sales focusing on marketing, business administration, and international business. Work on sales, acquisition, event logistics, and exhibition booth design.",
    bonuses:
      "Hands-on experience in trade fair development, portfolio building opportunities, creative freedom, networking with industry professionals",
    requirements:
      "Background in Marketing, Business Administration, or International Business. Skills in sales, acquisition, event logistics, and exhibition booth design.",
    languages: "English",
    contactMail: "",
    website: "https://ilikemedia.nl/",
  },
  {
    id: 21,
    logo: "https://ilike.media/wp-content/uploads/2022/04/Logo-Black-200x50-1.png",
    company: "iLike Media",
    specialty: "Journalism & Storytelling",
    location: "Remote",
    label: "International & Remote",
    duration: "Flexible",
    description:
      "An internship in journalism and storytelling focusing on reporting, interviewing, and long-form content development. Ideal for Journalism (RUG), Media & Culture, or Digital Humanities students.",
    bonuses:
      "Hands-on experience in journalism and storytelling, portfolio building opportunities, creative freedom, networking with industry professionals",
    requirements:
      "Background in Journalism, Media & Culture, or Digital Humanities. Skills in reporting, interviewing, and long-form content development.",
    languages: "English",
    contactMail: "",
    website: "https://ilikemedia.nl/",
  },
  {
    id: 16,
    logo: "https://big4accountingfirms.com/wp-content/uploads/Deloitte.svg.png",
    company: "Deloitte",
    specialty: "Summer Business Camp",
    location: "Sofia, Bulgaria",
    label: "Bulgarian",
    duration: "16 - 27 June 2025",
    description:
      "A two-week internship program where participants explore business fields like audit, finance, tax, legal, consulting, and advisory through workshops, case studies, and networking with industry professionals.",
    bonuses: "Certificate of completion, networking opportunities, potential for a permanent employment offer.",
    requirements:
      "Second-year university students or above, fluent in Bulgarian and English, curious and eager to learn, available in Sofia for the internship duration.",
    languages: "Bulgarian, English",
    contactMail: "",
    applyLink: "https://apply.deloittece.com/en_US/careers/ApplicationMethods?jobId=16533",
    website: "https://apply.deloittece.com/en_US/careers/JobDetail/Summer-Business-Camp/16533",
  },
  {
    id: 15,
    logo: "https://acady.nl/wp-content/uploads/2022/09/Acady-Logo-Final-01.png",
    company: "Acady",
    specialty: "Internships (see roles on the site)",
    location: "Hybrid / Remote | Netherlands",
    label: "International & Remote",
    duration: "full-time/flexible",
    description:
      "Join Acady and contribute across marketing, operations and product support. Work in a fast-moving environment and help scale impactful initiatives.",
    bonuses: "Hands-on experience, mentorship, flexible schedule, competitive base salary + high performance bonuses",
    requirements: "Motivated student or recent graduate with strong communication and organizational skills",
    languages: "English (Dutch is a plus)",
    contactMail: "",
    website: "https://acady.nl/join-our-team",
  },
  {
    id: 14,
    logo: "https://www.studentjobsrotterdam.nl/_next/image?url=%2Flogos%2Fpepperminds.jpeg&w=96&q=75",
    company: "Pepperminds",
    specialty: "Face-to-Face Fundraising Ambassador",
    location: "Groningen & Amsterdam",
    label: "International & Remote",
    duration: "Part-time / Flexible",
    description:
      "Work with a fun team to recruit face-to-face ambassadors for leading brands and charities such as CliniClowns, Staatsloterij, KIKA, Rode Kruis, UNICEF and KWF. Flexible shifts and strong growth opportunities.",
    bonuses: "Attractive base + bonus structure; average €150–€250 per shift; recruitment bonuses up to €300; masterclasses and events",
    requirements: "Communicative, proactive, and eager to develop sales skills; flexible availability; 16+",
    languages: "English",
    contactMail: "",
    website: "https://www.pepperminds.nl/makeithappen/?mkt=4930&recruitmentsource=Through_pepper",
  },
  {
    id: 13,
    logo: "https://neterra.net/images/upload/brands/logo-neterra_1.svg",
    company: "Neterra",
    specialty: "Junior Product Intern",
    location: "Sofia, Bulgaria / Hybrid",
    label: "Bulgarian",
    duration: "3/6 months",
    description:
      "As a Product Intern, you will play a key role in driving our quantitative and market analysis efforts. You'll work closely with experienced professionals in a collaborative environment where your contributions will make a real impact",
    bonuses: "Meaningful, hands-on experience, ",
    requirements:
      "TBD, depending on your skillset and background, diverse team in a global company and an opportunity for career advancement ",
    languages: "Bulgarian, English",
    contactMail: "cv@neterra.net",
    website: "https://neterra.net/",
  },
  {
    id: 12,
    logo: "https://www.pwc.bg/etc.clientlibs/pwc/clientlibs/rebrand-clientlibs/components-colors/resources/images/slim-header-v2/PwC-logo.svg",
    company: "PwC Bulgaria",
    specialty: "Junior Sustainability Audit Analyst",
    location: "Sofia, Bulgaria",
    label: "Bulgarian",
    duration: "Full-time",
    description:
      "Conduct financial and sustainability audits for the largest companies in Europe, ensuring compliance with ESRS, IFRS, and other reporting standards.",
    bonuses: "Experience in sustainability auditing and exposure to major European corporations.",
    requirements:
      "Degree in Accounting, Finance, Sustainability, or related field, Strong analytical and problem-solving abilities, Excellent communication and teamwork skills",
    languages: "Bulgarian, English",
    contactMail: "bg_pwc@pwc.com",
    website: "https://jobs-cee.pwc.com/ce/en/job/589706WD/Junior-Consultant-in-Audit-Finance",
  },
  {
    id: 11,
    logo: "https://www.bgstart.nl/bg/wp-content/uploads/2019/01/favicon.png",
    company: "BG Start",
    specialty: "Accountancy",
    location: "Amsterdam (Hybrid)",
    label: "International & Remote",
    duration: "Flexible",
    description:
      "Assisting with data entry, processing, and recording transactions. Financial Reporting: Helping prepare financial reports, budgets, and invoices. Administrative Support: Assisting with audits, fact-checking, and maintaining financial documents.",
    bonuses: "Experience & networking, Valuable mentoring opportunities",
    requirements: "Accounting knowledge, auditing experience",
    languages: "Bulgarian, English, Dutch (advantage)",
    contactMail: "lschroot@bgstart.nl",
    website: "https://www.bgstart.nl",
  },
  {
    id: 10,
    logo: "https://www.pwc.bg/etc.clientlibs/pwc/clientlibs/rebrand-clientlibs/components-colors/resources/images/slim-header-v2/PwC-logo.svg",
    company: "PwC Bulgaria",
    specialty: "Junior Consultant in Audit & Finance",
    location: "Sofia, Bulgaria",
    label: "Bulgarian",
    duration: "Full-time",
    description:
      "Perform financial analysis and data collection, including reviewing financial statements and drafting recommendations for improvements. Develop skills in strategic thinking by assisting clients in aligning their financial operations with their business objectives.",
    bonuses: "Gain valuable experience and expand your professional network by working with diverse clients across various industries.",
    requirements:
      "A solid understanding of accounting principles and practices, Previous experience in auditing or a strong interest in developing auditing skills.",
    languages: "Bulgarian, English",
    contactMail: "bg_pwc@pwc.com",
    website: "https://jobs-cee.pwc.com/ce/en/job/589706WD/Junior-Consultant-in-Audit-Finance",
  },
  {
    id: 9,
    logo: "",
    company: "MASTER OOD",
    specialty: "Engineering and Mechanical",
    location: "Bulgaria, Ruse",
    label: "Bulgarian",
    duration: "1-3 months",
    description: "Engineering and mechanical work in a workshop",
    bonuses: "Hands-on experience",
    requirements: "Bachelor's/Master's in Mechanical Engineering",
    languages: "Bulgarian",
    contactMail: "svetlozar.popov@master-bg.com",
    website: "https://www.master-bg.com",
  },
  {
    id: 8,
    logo: "/assets/images/brand/brand-04.png",
    company: "Study Buddy Ltd.",
    specialty: "Marketing, Social Media",
    location: "Remote",
    label: "International & Remote",
    duration: "2-3 months",
    description:
      "We are looking for interns to manage our Instagram and TikTok. Candidates should be outgoing, communicative, and comfortable producing video content.",
    bonuses: "Networking & exposure",
    requirements: "Marketing, PR, or related background",
    languages: "English, Bulgarian, German (plus)",
    contactMail: "marika@studybuddy.bg",
    website: "https://studybuddy.bg",
  },
  {
    id: 7,
    logo: "/assets/images/brand/brand-06.png",
    company: "Cool Travel Bulgaria",
    specialty: "Marketing, Management, Research",
    location: "Hybrid | Bulgaria, Sofia, Plovdiv, Varna, Burgas",
    label: "Bulgarian",
    duration: "TBD",
    description:
      "Internships available in various fields, with potential full-time opportunities. Contact Stefan Popov at popov@cooltravel.bg",
    bonuses: "Paid internship",
    requirements: "Strong research & marketing skills",
    languages: "Bulgarian, English",
    contactMail: "popov@cooltravel.bg",
    website: "https://www.cooltravel.bg",
  },
  {
    id: 6,
    logo: "https://substackcdn.com/image/fetch/w_264,c_limit,f_webp,q_auto:best,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F196bf711-6a0e-4e4d-bef8-6d389e8b8fa3_1280x1280.png",
    company: "Groningen Mail",
    specialty: "Content Creation, PR, Marketing",
    location: "Remote",
    label: "International & Remote",
    duration: "Various (some unlimited)",
    description: "Contribute content and assist operations for one of the top English news sources in Groningen.",
    bonuses: "Networking & coaching",
    requirements: "Relevant experience preferred",
    languages: "English",
    contactMail: "hello@groningenmail.com",
    website: "https://www.groningenmail.com",
  },
  {
    id: 5,
    logo: "https://www.domakin.nl/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Flogo-2.2290d784.png&w=1920&q=75",
    company: "Domakin",
    specialty: "Real Estate, Digital Marketing",
    location: "On-site, Hybrid, Remote | Netherlands",
    label: "International & Remote",
    duration: "4-10 months",
    description: "Student-run company helping navigate the Dutch real estate market. Join us for hands-on experience.",
    bonuses: "Mentoring & flexible schedule",
    requirements: "Availability on weekdays",
    languages: "English",
    contactMail: "domakin.nl@gmail.com",
    website: "https://www.domakin.nl",
  },
  {
    id: 4,
    logo: "https://careers.silverstar.bg/wp-content/uploads/2024/03/channels4_profile.jpg.webp",
    company: "Silver Star",
    specialty: "Marketing, Sales, Engineering",
    location: "On-site | Bulgaria, Plovdiv",
    label: "Bulgarian",
    duration: "Varies",
    description: "Internships with career growth potential at Silver Star.",
    bonuses: "Paid internship",
    requirements: "Field-related skills preferred",
    languages: "Bulgarian, English",
    contactMail: "",
    website: "https://careers.silverstar.bg/all-positions/",
  },
  {
    id: 3,
    logo: "https://southwesternadvantage.com/wp-content/uploads/2022/08/SWA-logo.svg",
    company: "Southwestern Advantage",
    specialty: "Management, Sales, Communication",
    location: "On-site | USA",
    label: "International & Remote",
    duration: "4-6 months",
    description:
      "Summer work & travel program for students, providing sales, leadership, and entrepreneurial experience.",
    bonuses: "Career growth & travel",
    requirements: "Full-time student, fluent English",
    languages: "English",
    contactMail: "angelinaivanova.swa@gmail.com",
    website: "https://southwesternadvantage.com",
  },
  {
    id: 2,
    logo: "https://assets.jobs.bg/assets/logo/2025-04-02/s_48b2f26d4b260d90e27860b24550c8f1.jpg",
    company: "Cargotec Bulgaria",
    specialty: "Finance, HR, Procurement",
    location: "Hybrid | Bulgaria, Sofia",
    label: "Bulgarian",
    duration: "4-6 months",
    description: "Year-long internship program in Finance, HR, and Procurement at Cargotec Bulgaria.",
    bonuses: "Health insurance & mentoring",
    requirements: "University student, 2 days on-site",
    languages: "English",
    contactMail: "antoniya.ivanova@hiab.com",
    website:
      "https://jobs.cargotec.com/search/?createNewAlert=false&q=&locationsearch=bulgaria&optionsFacetsDD_brand=&optionsFacetsDD_facility=&optionsFacetsDD_country=&optionsFacetsDD_city=",
  },
  {
    id: 1,
    logo: "https://nikiaviation.com/wp-content/uploads/2020/09/logo_niki-rotor-aviation1_NEW_text-krivi-1.png",
    company: "NIKI Rotor Aviation",
    specialty: "Aviation",
    location: "On-site | Bulgaria, Pravets",
    label: "Bulgarian",
    duration: "4-6 months",
    description: "Internship opportunities at Bulgaria's first and only gyrocopter manufacturer.",
    bonuses: "Paid internship",
    requirements: "Technical knowledge preferred",
    languages: "Bulgarian, English",
    contactMail: "info@nikiaviation.com",
    website: "https://nikiaviation.com/",
  },
];

// ── S3 setup ───────────────────────────────────────────────────────────────
const BUCKET = process.env.BUCKET_DOCUMENTS;
const REGION = process.env.S3_BUCKET_REGION || "eu-central-1";

const s3 = new AWS.S3({
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_KEY,
  region: REGION,
});

// Frontend public dir for local logo assets
const FRONTEND_PUBLIC = path.resolve(__dirname, "../../BGSNL/public");

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function extFromUrl(url) {
  const cleanUrl = url.split("?")[0];
  const parts = cleanUrl.split(".");
  const ext = parts[parts.length - 1].toLowerCase();
  return ["jpg", "jpeg", "png", "webp", "svg", "gif"].includes(ext) ? ext : "png";
}

function mimeFromExt(ext) {
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml", gif: "image/gif" };
  return map[ext] || "image/png";
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, { headers: { "User-Agent": "BGSNL-seed-script/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function uploadLogo(logoSrc, company, specialty) {
  if (!logoSrc) return "";

  const slug = `${slugify(company)}-${slugify(specialty)}`;

  // Local asset path (e.g. /assets/images/brand/brand-04.png)
  if (logoSrc.startsWith("/")) {
    const localPath = path.join(FRONTEND_PUBLIC, logoSrc);
    if (!fs.existsSync(localPath)) {
      console.warn(`  [WARN] Local file not found: ${localPath}`);
      return "";
    }
    const buffer = fs.readFileSync(localPath);
    const ext = extFromUrl(logoSrc);
    const key = `internship-logos/${slug}.${ext}`;
    console.log(`  Uploading local file -> s3://${BUCKET}/${key}`);
    if (apply) {
      await s3.putObject({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: mimeFromExt(ext) }).promise();
    }
    return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
  }

  // Remote URL
  const ext = extFromUrl(logoSrc);
  const key = `internship-logos/${slug}.${ext}`;
  console.log(`  Downloading ${logoSrc}`);
  let buffer;
  try {
    buffer = await downloadUrl(logoSrc);
  } catch (err) {
    console.warn(`  [WARN] Could not download logo: ${err.message}`);
    return "";
  }
  console.log(`  Uploading -> s3://${BUCKET}/${key}`);
  if (apply) {
    await s3.putObject({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: mimeFromExt(ext) }).promise();
  }
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!apply) {
    console.log("DRY-RUN mode — pass --apply to write to DB and S3\n");
  }

  // Connect to MongoDB
  const mongoUri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
  console.log(`Connecting to MongoDB...`);
  if (apply) {
    await mongoose.connect(mongoUri);
    console.log("Connected.\n");
  } else {
    console.log("(skipped in dry-run)\n");
  }

  // Deduplicate: group by company so the same logo URL isn't downloaded multiple times
  const logoCache = new Map(); // originalLogoSrc -> s3Url

  let created = 0;
  let skipped = 0;

  for (const item of INTERNSHIPS_LIST) {
    console.log(`\nProcessing [${item.id}] ${item.company} — ${item.specialty}`);

    // Check for existing record
    if (apply) {
      const existing = await Internship.findOne({ company: item.company, specialty: item.specialty });
      if (existing) {
        console.log("  Already exists — skipping.");
        skipped++;
        continue;
      }
    }

    // Upload logo (deduplicated by original src)
    let logoUrl = "";
    if (item.logo) {
      if (logoCache.has(item.logo)) {
        logoUrl = logoCache.get(item.logo);
        console.log(`  Reusing cached logo: ${logoUrl}`);
      } else {
        logoUrl = await uploadLogo(item.logo, item.company, item.specialty);
        logoCache.set(item.logo, logoUrl);
      }
    }

    const doc = {
      company: item.company,
      specialty: item.specialty,
      location: item.location,
      label: item.label,
      duration: item.duration || "",
      description: item.description || "",
      bonuses: item.bonuses || "",
      requirements: item.requirements || "",
      languages: item.languages || "",
      contactMail: item.contactMail || "",
      website: item.website || "",
      applyLink: item.applyLink || "",
      logo: logoUrl,
    };

    console.log(`  logo -> ${logoUrl || "(none)"}`);

    if (apply) {
      await new Internship(doc).save();
      console.log("  Saved to DB.");
    } else {
      console.log("  [dry-run] Would save:", JSON.stringify(doc, null, 2));
    }
    created++;
  }

  console.log(`\nDone. Created: ${created}, Skipped (already exist): ${skipped}`);

  if (apply) {
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
