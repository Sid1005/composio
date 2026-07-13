import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const siteRoot = process.cwd();
const assignmentRoot = path.resolve(siteRoot, "../agent");
const publicData = path.join(siteRoot, "public/data");
const appData = path.join(siteRoot, "app/data");

const categoryNames = [
  "CRM & Sales",
  "Support & Helpdesk",
  "Communications",
  "Marketing & Social",
  "Ecommerce",
  "Data & Scraping",
  "Developer & Infrastructure",
  "Productivity",
  "Finance",
  "AI & Media",
];

const slugify = (value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

await rm(publicData, { recursive: true, force: true });
await mkdir(path.join(publicData, "research"), { recursive: true });
await mkdir(path.join(publicData, "verification"), { recursive: true });
await mkdir(path.join(publicData, "traces"), { recursive: true });
await mkdir(path.join(publicData, "screenshots"), { recursive: true });
await mkdir(appData, { recursive: true });

const appsSource = await readFile(path.join(assignmentRoot, "src/apps_list.py"), "utf8");
const apps = [...appsSource.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map(
  ([, name, url], index) => ({ name, url, category: categoryNames[Math.floor(index / 10)] }),
);

if (apps.length !== 100) throw new Error(`Expected 100 apps, found ${apps.length}`);

const verificationIds = new Set();
const correctionCounts = new Map();
const verificationResults = new Map();

for (const app of apps) {
  const id = slugify(app.name);
  const verificationPath = path.join(assignmentRoot, `data/verification/${id}-verification.json`);
  try {
    const verification = JSON.parse(await readFile(verificationPath, "utf8"));
    verificationIds.add(id);
    correctionCounts.set(id, verification.corrections?.length ?? 0);
    verificationResults.set(id, verification.browser_verification?.result ?? "not_sampled");
    await copyFile(verificationPath, path.join(publicData, `verification/${id}.json`));
  } catch {
    // Only the fixed 15-app sample has verification files.
  }
}

const index = [];
for (const app of apps) {
  const id = slugify(app.name);
  const sourcePath = path.join(assignmentRoot, `data/apps/${id}-research.json`);
  const record = JSON.parse(await readFile(sourcePath, "utf8"));
  const f = record.findings;
  const qaFlags = [];

  if (f.buildability.verdict === "buildable_today" && f.buildability.main_blocker !== "none_material") {
    qaFlags.push("Buildable today, but a material blocker is also recorded");
  }
  if (f.buildability.verdict === "buildable_today" && f.access.credential_access === "sales_gated") {
    qaFlags.push("Buildable today, but credential access is recorded as sales-gated");
  }
  if (id === "fanbasis") {
    qaFlags.push("Human login contradicted pass 1: the API key was not self-serve and an MCP server exists");
  }

  index.push({
    id,
    name: app.name,
    url: app.url,
    category: app.category,
    auth: f.authentication.methods.value,
    access: f.access.credential_access,
    signupFriction: f.access.signup_friction,
    publicApi: f.api_surface.public_api,
    breadth: f.api_surface.breadth,
    mcp: f.agent_interface.mcp,
    verdict: f.buildability.verdict,
    blocker: f.buildability.main_blocker,
    oneLiner: f.classification.one_liner.value,
    sources: Object.keys(record.sources).length,
    verified: verificationIds.has(id),
    verificationResult: verificationResults.get(id) ?? "not_sampled",
    corrections: correctionCounts.get(id) ?? 0,
    humanCorrection: id === "fanbasis",
    qaFlags,
  });

  await copyFile(sourcePath, path.join(publicData, `research/${id}.json`));
  const tracePath = path.join(assignmentRoot, `logs/${id}-trace.jsonl`);
  try {
    await copyFile(tracePath, path.join(publicData, `traces/${id}.jsonl`));
  } catch {
    // A missing trace should not block the case-study build.
  }
}

for (const image of ["fanbasis-1.png", "mrscraper-3.png", "neo4j-1.png"]) {
  await copyFile(
    path.join(assignmentRoot, `data/screenshots/${image}`),
    path.join(publicData, `screenshots/${image}`),
  );
}

await writeFile(path.join(appData, "index.json"), JSON.stringify(index, null, 2));
