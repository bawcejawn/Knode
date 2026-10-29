import { execSync } from "node:child_process";
for (const u of ["https://bawcejawn.github.io/Knode/site/install.html", "https://bawcejawn.github.io/Knode/", "https://www.knodegames.com/", "http://knodegames.com/", "https://knodegames.com/install.html", "https://knodegames.com/sitemap.xml", "https://knodegames.com/robots.txt"]) {
  const o = execSync(`curl -s -o /dev/null -L -w "%{http_code} %{url_effective}" "${u}" || true`, { encoding: "utf8" });
  console.log(`::warning::${u} -> ${o}`);
}
