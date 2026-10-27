// Writes each page's search and share tags (title, description, canonical link, Open Graph, Twitter, and JSON-LD on the
// game page), plus robots.txt and sitemap.xml at the site root. Run after changing SITE (for example when the custom
// domain is live) or a page's text:   node tools/site-seo.mjs
// SITE is the address of the site/ folder. With a custom domain whose root serves this repository, it becomes
// "https://your-domain/site/"; robots.txt and sitemap.xml are written to the repository root, which is the domain root.
import fs from "node:fs";

export const SITE = "https://bawcejawn.github.io/Knode/site/";
const ROOT = new URL("../", import.meta.url).pathname;

export const PAGES = [
  { file: "index.html", path: "", title: "Knode: the daily Koinos prediction game", short: "Knode: call the next blocks",
    desc: "A free daily guessing game on the Koinos blockchain. Answer 5 questions a day about block producers, climb the weekly leaderboard, and win VHP.", image: "og-knode.png", priority: "1.0" },
  { file: "get.html", path: "get.html", title: "Get KOIN and VHP · Knode", short: "Get KOIN and VHP",
    desc: "How to get KOIN and VHP to play Knode: a Koinos wallet, vKOIN on Uniswap or Jupiter, the Vortex bridge, burn into VHP, stake, and swap back any time.", image: "og-knode.png", priority: "0.8" },
  { file: "install.html", path: "install.html", title: "Get the Knode app · iPhone, Android and computer", short: "Get the Knode app",
    desc: "Install Knode on your phone or computer in three taps, straight from the website. No app store needed.", image: "og-knode.png", priority: "0.8" },
  { file: "swap.html", path: "swap.html", title: "Knode Swap · Swap VHP for KOIN on Koinos", short: "Knode Swap",
    desc: "Swap VHP back into KOIN in one step on Koinos. A small 3% fee, paid out from Knode's own node.", image: "og-swap.png", priority: "0.7" },
  { file: "start.html", path: "start.html", title: "New to Koinos? Start here · Knode", short: "New to Koinos? Start here",
    desc: "From dollars in the bank to playing Knode: get a wallet, get KOIN, cross the Vortex bridge, and explore apps built on Koinos.", image: "og-knode.png", priority: "0.7" },
  { file: "node.html", path: "node.html", title: "Koinos producer lookup · Knode", short: "Koinos producer lookup",
    desc: "Look up any Koinos block producer: blocks signed over the last two days, share of the network, and recent activity.", image: "og-knode.png", priority: "0.6" },
  { file: "burn.html", path: "burn.html", title: "Burn KOIN into VHP · Knode", short: "Burn KOIN into VHP",
    desc: "Turn KOIN into VHP, 1 for 1, with your own wallet, so you can stake it in Knode or produce blocks.", image: "og-knode.png", priority: "0.5" },
  { file: "trust.html", path: "trust.html", title: "Trust and safety · Knode", short: "Trust and safety",
    desc: "Live checks on Knode's contracts: who controls what, the code fingerprints, the timelocks, and whether every stake is covered.", image: "og-knode.png", priority: "0.5" },
  { file: "terms.html", path: "terms.html", title: "Terms and risks · Knode", short: "Terms and risks",
    desc: "The terms and the risks of playing Knode and using Knode Swap.", image: "og-knode.png", priority: "0.3" },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function seoBlock(p) {
  const url = SITE + p.path, img = SITE + "media/" + p.image;
  const lines = [
    "<!-- seo:start (written by tools/site-seo.mjs; edit there) -->",
    `<meta name="description" content="${esc(p.desc)}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Knode">`,
    `<meta property="og:title" content="${esc(p.short)}">`,
    `<meta property="og:description" content="${esc(p.desc)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${img}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(p.short)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(p.short)}">`,
    `<meta name="twitter:description" content="${esc(p.desc)}">`,
    `<meta name="twitter:image" content="${img}">`,
  ];
  if (p.file === "index.html") {
    const ld = { "@context": "https://schema.org", "@graph": [
      { "@type": "WebSite", name: "Knode", url: SITE, description: p.desc },
      { "@type": ["WebApplication", "VideoGame"], name: "Knode", url: SITE, applicationCategory: "GameApplication", genre: "Prediction game",
        operatingSystem: "Any (web browser; installable)", description: p.desc, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
    ] };
    // A data block, not a script: browsers never run it, so the Content-Security-Policy does not apply to it.
    lines.push(`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`);
  }
  lines.push("<!-- seo:end -->");
  return lines.map((l) => "  " + l).join("\n");
}

const STRIP = [/^\s*<meta name="description"[^>]*>\n/gm, /^\s*<link rel="canonical"[^>]*>\n/gm, /^\s*<meta property="og:[^>]*>\n/gm, /^\s*<meta name="twitter:[^>]*>\n/gm];

export function apply(html, p) {
  let s = html.replace(/^\s*<!-- seo:start[\s\S]*?<!-- seo:end -->\n/m, "");
  for (const r of STRIP) s = s.replace(r, "");
  s = s.replace(/<title>[^<]*<\/title>/, `<title>${esc(p.title).replace(/&quot;/g, '"')}</title>`);
  return s.replace(/(<title>[^<]*<\/title>\n)/, `$1${seoBlock(p)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("site-seo.mjs")) {
  for (const p of PAGES) {
    const f = ROOT + "site/" + p.file;
    fs.writeFileSync(f, apply(fs.readFileSync(f, "utf8"), p));
  }
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(ROOT + "sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.map((p) => `  <url><loc>${SITE + p.path}</loc><lastmod>${today}</lastmod><priority>${p.priority}</priority></url>`).join("\n")}\n</urlset>\n`);
  fs.writeFileSync(ROOT + "robots.txt", `# Served from the domain root once Knode has its own domain (until then search engines read it at the github.io root).\nUser-agent: *\nAllow: /\nDisallow: /site/producer.html\nSitemap: ${SITE.replace(/site\/$/, "")}sitemap.xml\n`);
  console.log(`Wrote tags for ${PAGES.length} pages, sitemap.xml and robots.txt (site: ${SITE}).`);
}
