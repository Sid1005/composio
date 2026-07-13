"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import indexData from "./data/index.json";

type AppSummary = {
  id: string;
  name: string;
  url: string;
  category: string;
  auth: string[];
  access: string;
  signupFriction: string;
  publicApi: string;
  breadth: string;
  mcp: string;
  verdict: string;
  blocker: string;
  oneLiner: string;
  sources: number;
  verified: boolean;
  verificationResult: string;
  corrections: number;
  humanCorrection: boolean;
  qaFlags: string[];
};

type ResearchRecord = {
  app_id: string;
  researched_at: string;
  findings: {
    classification: { one_liner: { value: string } };
    authentication: { methods: { value: string[] }; primary_for_agent_toolkit: string };
    access: {
      credential_access: string;
      signup_friction: string;
      paid_plan_required_for_api: string;
      admin_approval_required: string;
      notes?: string;
    };
    api_surface: {
      public_api: string;
      protocols: string[];
      breadth: string;
      summary: { value: string };
      api_docs_url?: string;
    };
    agent_interface: { mcp: string; mcp_endpoint?: string; notes?: string };
    buildability: {
      verdict: string;
      main_blocker: string;
      rationale: { value: string };
    };
  };
  sources: Record<string, { url: string; quote: string; title?: string; source_type: string }>;
  limitations?: string[];
};

type TraceLine = {
  turn: number;
  tool: string;
  arguments?: Record<string, unknown>;
  result_len?: number;
};

type TabId = "overview" | "findings" | "apps" | "verification" | "agent";
type LiveStatus = "idle" | "connecting" | "running" | "done" | "error";

const apps = indexData as AppSummary[];
const categories = Array.from(new Set(apps.map((app) => app.category)));

const GITHUB_URL = "https://github.com/Sid1005/composio";

// One clean, fast-loading example per category for the pre-recorded sample viewer.
const SAMPLE_IDS = [
  "attio", "plain", "pumble", "systeme-io", "shopify",
  "mrscraper", "github", "linear", "stripe", "reducto",
];

const categoryResults = [
  ["Developer & Infrastructure", 10, "Ready across the sample"],
  ["Productivity", 10, "Ready across the sample"],
  ["Support & Helpdesk", 9, "1 needs access work"],
  ["Communications", 9, "1 needs access work"],
  ["Data & Scraping", 9, "1 needs access work"],
  ["CRM & Sales", 8, "2 need access work"],
  ["Ecommerce", 8, "2 need access work"],
  ["AI & Media", 8, "2 need access work"],
  ["Marketing & Social", 6, "4 need access work"],
  ["Finance", 6, "4 need access work"],
] as const;

// The 15-app verification sample, one row per company: what the browser
// re-check concluded, and what a human found by actually signing up.
const verificationRows: Array<{
  app: string;
  browser: "confirmed" | "partial" | "corrected";
  browserNote: string;
  human: string;
}> = [
  { app: "Attio", browser: "confirmed", browserNote: "All six fields matched the rendered pages.", human: "Signing up needs a work email." },
  { app: "Salesforce", browser: "confirmed", browserNote: "All six fields matched.", human: "Connected to Composio directly. Has an MCP servers page." },
  { app: "Pylon", browser: "partial", browserNote: "API key auth confirmed. The OAuth2 claim was not visible on the rendered pages.", human: "Signing up needs a work email." },
  { app: "Pumble", browser: "confirmed", browserNote: "All six fields matched.", human: "API keys and an MCP server, as claimed." },
  { app: "systeme.io", browser: "confirmed", browserNote: "All six fields matched.", human: "API keys and an MCP server, as claimed." },
  { app: "Fanbasis", browser: "partial", browserNote: "Main site returned 403 to the browser. API docs confirmed, access claims could not be checked.", human: "This one beat us. See the full story below." },
  { app: "MrScraper", browser: "corrected", browserNote: "The agent said no MCP server. The docs sidebar clearly lists an MCP Server page. 1 correction logged.", human: "API keys and an MCP server confirmed." },
  { app: "Neo4j", browser: "corrected", browserNote: "The webhooks claim and the exact MCP endpoint were not backed by the rendered pages. 2 corrections logged.", human: "Admin credentials are shown exactly once at instance creation." },
  { app: "Linear", browser: "confirmed", browserNote: "All six fields matched.", human: "API keys and an MCP server, as claimed." },
  { app: "Twenty", browser: "confirmed", browserNote: "All six fields matched.", human: "API keys and an MCP server, as claimed." },
  { app: "Plain", browser: "confirmed", browserNote: "All six fields matched.", human: "API keys and an MCP server, as claimed." },
  { app: "Reducto", browser: "confirmed", browserNote: "All six fields matched.", human: "API keys and an MCP server, as claimed." },
  { app: "Paygent Connect", browser: "confirmed", browserNote: "All six fields matched.", human: "No MCP server found. Matches the agent." },
  { app: "Waterfall.io", browser: "confirmed", browserNote: "All six fields matched.", human: "No MCP server. The only way to get an account is to book a call." },
  { app: "DealCloud", browser: "confirmed", browserNote: "All six fields matched.", human: "Login is for existing customers only. New access needs a demo." },
];

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "findings", label: "Findings" },
  { id: "apps", label: "App records" },
  { id: "verification", label: "Verification" },
  { id: "agent", label: "Run the agent" },
];

const titleCase = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());

const shortTool = (tool: string) =>
  tool.replace("COMPOSIO_SEARCH_", "").replace("FETCH_URL_CONTENT", "FETCH PAGE").replace("TAVILY", "SEARCH");

// Live runs execute on our VM with our API keys, so visitors need no setup.
// /api/run proxies the stream server-side (see app/api/run/route.ts).
const AGENT_RUN_URL = "/api/run";

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [category, setCategory] = useState(categories[0]);
  const [selectedId, setSelectedId] = useState("salesforce");
  const [selectedRecord, setSelectedRecord] = useState<ResearchRecord | null>(null);

  const [sampleId, setSampleId] = useState("attio");
  const [sampleTrace, setSampleTrace] = useState<TraceLine[]>([]);
  const [sampleRecord, setSampleRecord] = useState<ResearchRecord | null>(null);

  const [liveAppId, setLiveAppId] = useState(apps[0]?.id ?? "attio");
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("idle");
  const [liveLines, setLiveLines] = useState<TraceLine[]>([]);
  const [liveResult, setLiveResult] = useState<ResearchRecord | null>(null);
  const [liveError, setLiveError] = useState<string>("");
  const eventSourceRef = useRef<EventSource | null>(null);

  const categoryApps = useMemo(
    () => apps.filter((app) => app.category === category),
    [category],
  );

  useEffect(() => {
    // keep the detail panel pointed at an app in the visible category
    if (!categoryApps.some((app) => app.id === selectedId) && categoryApps[0]) {
      setSelectedId(categoryApps[0].id);
    }
  }, [categoryApps, selectedId]);

  useEffect(() => {
    let active = true;
    fetch(`/data/research/${selectedId}.json`)
      .then((response) => response.json())
      .then((record) => active && setSelectedRecord(record))
      .catch(() => active && setSelectedRecord(null));
    return () => { active = false; };
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`/data/traces/${sampleId}.jsonl`).then((response) => {
        if (!response.ok) throw new Error("trace unavailable");
        return response.text();
      }),
      fetch(`/data/research/${sampleId}.json`).then((response) => {
        if (!response.ok) throw new Error("record unavailable");
        return response.json();
      }),
    ])
      .then(([traceText, record]) => {
        if (!active) return;
        setSampleTrace(traceText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
        setSampleRecord(record);
      })
      .catch(() => {
        if (!active) return;
        setSampleTrace([]);
        setSampleRecord(null);
      });
    return () => { active = false; };
  }, [sampleId]);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  const runLiveAgent = () => {
    eventSourceRef.current?.close();
    const app = apps.find((a) => a.id === liveAppId);
    if (!app) return;

    setLiveStatus("connecting");
    setLiveLines([]);
    setLiveResult(null);
    setLiveError("");

    const params = new URLSearchParams({ app: app.name, url: app.url || "" });
    const es = new EventSource(`${AGENT_RUN_URL}?${params.toString()}`);
    eventSourceRef.current = es;

    es.addEventListener("status", () => setLiveStatus("running"));
    es.addEventListener("trace", (event) => {
      setLiveStatus("running");
      setLiveLines((lines) => [...lines, JSON.parse((event as MessageEvent).data)]);
    });
    es.addEventListener("result", (event) => {
      setLiveResult(JSON.parse((event as MessageEvent).data));
      setLiveStatus("done");
      es.close();
    });
    es.addEventListener("run-error", (event) => {
      setLiveError(JSON.parse((event as MessageEvent).data).message);
      setLiveStatus("error");
      es.close();
    });
    es.onerror = () => {
      if (liveStatus !== "done") {
        setLiveError("Can't reach the agent server right now. It may be busy with another run — try again in a minute.");
        setLiveStatus("error");
      }
      es.close();
    };
  };

  const selectedSummary = apps.find((app) => app.id === selectedId);
  const selectedSources = selectedRecord ? Object.entries(selectedRecord.sources).slice(0, 4) : [];
  const sampleApps = apps.filter((app) => SAMPLE_IDS.includes(app.id));

  return (
    <main className="shell">
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <b>Toolkit research</b>
        </div>
        <nav className="topbar-tabs" role="tablist" aria-label="Case study sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="topbar-links">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub ↗</a>
          <button type="button" className="cta" onClick={() => setActiveTab("agent")}>Run the agent live</button>
        </div>
      </header>

      {/* ── OVERVIEW ─────────────────────────────────────────────── */}
      <section className="page" hidden={activeTab !== "overview"}>
        <p className="eyebrow">100 apps · 10 categories · researched by an agent, checked by a browser and a human</p>

        <div className="stat-band">
          <div><strong>100</strong><span>Apps researched</span></div>
          <div><strong>97</strong><span>Have a public API</span></div>
          <div><strong>83</strong><span>Buildable today</span></div>
          <div><strong>15</strong><span>Checked by browser + human</span></div>
        </div>

        <p className="stat-caption">17 apps were not buildable today. 16 of those were blocked by access: a paid API plan, admin approval, or a sales call. Only 1 was missing a public API.</p>

        <div className="how-strip">
          <span className="card-tag">HOW THIS WORKS</span>
          <p>One Python script researches one app at a time. <b>DeepSeek V4 Flash</b> does the reasoning, called through the opencode endpoint. The <b>Composio SDK</b> gives it its tools: web search (Tavily) and page fetching. Every claim must cite a URL and a quote the agent actually fetched, and each record is validated against a JSON schema before it is saved. No evidence means the field says "unknown", never a guess.</p>
        </div>

        <div className="overview-grid">
          <button type="button" className="overview-card" onClick={() => setActiveTab("findings")}>
            <span className="card-tag">FINDINGS</span>
            <b>What the 100 runs showed</b>
            <ul>
              <li>95 apps have a REST API, 84 have webhooks.</li>
              <li>71 hand out credentials free and self-serve. 14 need a paid plan, 8 need a sales call.</li>
              <li>80 support OAuth 2.0, 65 support API keys, 51 support both.</li>
              <li>Developer tools and productivity apps are all buildable. Finance and marketing are the hardest.</li>
            </ul>
            <em>See all findings →</em>
          </button>

          <button type="button" className="overview-card" onClick={() => setActiveTab("apps")}>
            <span className="card-tag">APP RECORDS</span>
            <b>Every answer has a source</b>
            <ul>
              <li>One JSON record per app: auth, access, API surface, MCP, verdict.</li>
              <li>Each claim points to a URL and a quote the agent actually fetched.</li>
              <li>Where the agent found nothing, the record says "unknown" instead of guessing.</li>
            </ul>
            <em>Browse by category →</em>
          </button>

          <button type="button" className="overview-card" onClick={() => setActiveTab("verification")}>
            <span className="card-tag">VERIFICATION</span>
            <b>We double-checked 15 apps</b>
            <ul>
              <li>A real browser re-opened the same pages and re-judged every field. 11 of 15 fully matched.</li>
              <li>3 corrections: a missed MCP server and two claims that were too broad.</li>
              <li>A human then tried to actually sign up. That caught gates no page mentions.</li>
            </ul>
            <em>See the full check →</em>
          </button>
        </div>

        <div className="defeat-banner">
          <span className="defeat-tag">WHERE WE GOT IT WRONG</span>
          <p><b>Fanbasis beat us.</b> The docs say you get your API key from the dashboard. A human logged in and went looking: the dashboard has no place to get an API key at all. What it does have is a customer portal login demanding an authentication token, which we suspect gates the keys — we never got past it. And there is an MCP server the agent had missed entirely. Fully defeated: we never got an API key.</p>
          <button type="button" onClick={() => setActiveTab("verification")}>Read the full story →</button>
        </div>
      </section>

      {/* ── FINDINGS ─────────────────────────────────────────────── */}
      <section className="page" hidden={activeTab !== "findings"}>
        <div className="page-title">
          <h2>What the 100 runs showed</h2>
          <p>All figures come straight from the 100 final JSON records.</p>
        </div>

        <div className="finding-rows">
          <article><span className="row-number">01</span><div><b>Public APIs were common.</b><p>97 apps had a public API; 86 were broad enough for useful agent actions.</p></div><dl><div><dt>REST</dt><dd>95</dd></div><div><dt>Webhooks</dt><dd>84</dd></div><div><dt>GraphQL</dt><dd>18</dd></div></dl></article>
          <article><span className="row-number">02</span><div><b>Credential access stopped builds.</b><p>14 needed paid API access, 2 needed a sales contract, and 1 had no public API.</p></div><dl><div><dt>Free</dt><dd>71</dd></div><div><dt>Trial</dt><dd>5</dd></div><div><dt>Paid</dt><dd>14</dd></div><div><dt>Sales/admin/unknown</dt><dd>10</dd></div></dl></article>
          <article><span className="row-number">03</span><div><b>OAuth and API keys often appeared together.</b><p>51 apps supported both. Authentication method counts overlap.</p></div><dl><div><dt>OAuth 2.0</dt><dd>80</dd></div><div><dt>API key</dt><dd>65</dd></div><div><dt>Both</dt><dd>51</dd></div></dl></article>
          <article><span className="row-number">04</span><div><b>MCP was the least reliable field.</b><p>The agent reported 72 official and 22 community MCP servers. Only 10 of 15 sampled MCP claims were fully confirmed.</p></div><dl><div><dt>Confirmed</dt><dd>10</dd></div><div><dt>Partial/unclear</dt><dd>4</dd></div><div><dt>Wrong</dt><dd>1</dd></div></dl></article>
        </div>

        <div className="section-label">Buildable today, by category</div>
        <div className="category-table" role="table" aria-label="Buildability by category">
          <div className="category-head" role="row"><span>Category</span><span>Result</span><span>Buildable today</span><span>Note</span></div>
          {categoryResults.map(([name, score, note]) => (
            <div className="category-row" role="row" key={name}>
              <b>{name}</b>
              <strong>{score}/10</strong>
              <span className="numbered-bar" aria-label={`${score} of 10 buildable today`}><i style={{ width: `${score * 10}%` }} /><em>{score * 10}%</em></span>
              <span>{note}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── APP RECORDS ──────────────────────────────────────────── */}
      <section className="page" hidden={activeTab !== "apps"}>
        <div className="page-title">
          <h2>App records</h2>
          <p>Ten apps per category. Click a row for the full record and its sources.</p>
        </div>

        <div className="category-chips" role="tablist" aria-label="Categories">
          {categories.map((item) => (
            <button key={item} type="button" className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>
          ))}
        </div>

        <div className="records-layout">
          <div className="records-table-wrap">
            <table className="records-table">
              <thead><tr><th>App</th><th>Auth</th><th>Access</th><th>API</th><th>MCP</th><th>Verdict</th><th>Check</th></tr></thead>
              <tbody>{categoryApps.map((app) => (
                <tr key={app.id} className={selectedId === app.id ? "selected" : ""}>
                  <td><button type="button" onClick={() => setSelectedId(app.id)}><b>{app.name}</b></button></td>
                  <td>{app.auth.slice(0, 2).map(titleCase).join(" + ")}</td>
                  <td>{titleCase(app.access)}</td>
                  <td>{titleCase(app.breadth)}</td>
                  <td>{titleCase(app.mcp)}</td>
                  <td>{titleCase(app.verdict)}</td>
                  <td>{app.humanCorrection ? <span className="status wrong">Human fix</span> : app.qaFlags.length ? <span className="status wrong">Flag</span> : app.verified ? <span className={`status ${app.verificationResult === "confirmed" ? "good" : "partial"}`}>{app.verificationResult === "confirmed" ? "Confirmed" : "Partial"}</span> : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <aside className="record-detail" aria-live="polite">
            {selectedRecord && selectedSummary ? <>
              <div className="box-title"><span>SELECTED RECORD</span><em>{selectedSummary.sources} SOURCES</em></div>
              <h3>{selectedSummary.name}</h3>
              <p>{selectedSummary.oneLiner}</p>
              <div className="detail-fields">
                <div><span>Auth</span><b>{selectedRecord.findings.authentication.methods.value.map(titleCase).join(", ")}</b></div>
                <div><span>Access</span><b>{titleCase(selectedRecord.findings.access.credential_access)}</b></div>
                <div><span>API</span><b>{titleCase(selectedRecord.findings.api_surface.breadth)} · {selectedRecord.findings.api_surface.protocols.map(titleCase).join(", ")}</b></div>
                <div><span>MCP</span><b>{titleCase(selectedRecord.findings.agent_interface.mcp)}</b></div>
                <div><span>Agent verdict</span><b>{titleCase(selectedRecord.findings.buildability.verdict)}</b></div>
              </div>
              {selectedSummary.qaFlags.length > 0 && <div className="record-alert"><b>{selectedSummary.humanCorrection ? "Human correction" : "Unresolved conflict"}</b>{selectedSummary.qaFlags.map((flag) => <p key={flag}>{flag}</p>)}</div>}
              <div className="source-links"><span>Source sample</span>{selectedSources.map(([id, source]) => <a href={source.url} target="_blank" rel="noreferrer" key={id}><b>{source.title || source.source_type}</b><small>{source.quote.slice(0, 100)}{source.quote.length > 100 ? "…" : ""}</small></a>)}</div>
            </> : <p>Loading record…</p>}
          </aside>
        </div>
      </section>

      {/* ── VERIFICATION ─────────────────────────────────────────── */}
      <section className="page" hidden={activeTab !== "verification"}>
        <div className="page-title">
          <h2>Verification</h2>
          <p>We took 15 of the 100 apps, at least one from every category, and checked the agent's answers two ways.</p>
        </div>

        <div className="check-explainers">
          <div>
            <span className="card-tag">CHECK 1 · BROWSER</span>
            <b>Re-read the same pages with a real browser</b>
            <p>Chromium (via Playwright) opened the exact pages the agent had cited, took a screenshot of each, and a fresh model pass re-judged all six fields from only what was rendered on screen. This catches what text scraping misses: checkmark-only pricing tables, sidebar links, anything drawn by JavaScript.</p>
          </div>
          <div>
            <span className="card-tag">CHECK 2 · HUMAN</span>
            <b>Actually try to sign up</b>
            <p>Pages can say one thing and do another. A human created accounts, hunted for the API key page, and connected MCP servers. This is the only check that catches gates no documentation mentions.</p>
          </div>
        </div>

        <div className="stat-band small">
          <div><strong>15</strong><span>Apps checked</span></div>
          <div><strong>11</strong><span>Fully confirmed</span></div>
          <div><strong>3</strong><span>Corrections logged</span></div>
          <div><strong>1</strong><span>Defeated us</span></div>
        </div>

        <div className="verify-table-wrap">
          <table className="verify-table">
            <thead><tr><th>App</th><th>Browser check</th><th>What a human found</th></tr></thead>
            <tbody>
              {verificationRows.map((row) => (
                <tr key={row.app} className={row.app === "Fanbasis" ? "defeat-row" : ""}>
                  <td><b>{row.app}</b></td>
                  <td>
                    <span className={`status ${row.browser === "confirmed" ? "good" : row.browser === "partial" ? "partial" : "wrong"}`}>
                      {row.browser === "confirmed" ? "Confirmed" : row.browser === "partial" ? "Partial" : "Corrected"}
                    </span>
                    <p>{row.browserNote}</p>
                  </td>
                  <td><p>{row.human}</p></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="defeat-banner">
          <span className="defeat-tag">THE FANBASIS STORY, IN ORDER</span>
          <div className="defeat-steps">
            <div><span>1 · AGENT</span><p>Said: free self-serve signup, API keys generated from the dashboard, no MCP server.</p></div>
            <div><span>2 · BROWSER</span><p>The main site returned 403 to the browser. The docs sidebar showed an "AI Agent" section it couldn't open. Verdict: unclear, not wrong.</p></div>
            <div><span>3 · HUMAN</span><p>Logged in for real. The MCP server is there — the agent had missed it. But the dashboard has no place to get an API key at all, only a customer portal login demanding an authentication token. We suspect the keys are gated behind it. We never got one. Fully defeated.</p></div>
          </div>
          <p className="defeat-moral">Both automated passes were honestly cited and still wrong. That is why the human check exists.</p>
        </div>
      </section>

      {/* ── AGENT ────────────────────────────────────────────────── */}
      <section className="page" hidden={activeTab !== "agent"}>
        <div className="page-title">
          <h2>Run the agent</h2>
          <p>DeepSeek V4 Flash does the reasoning. The Composio SDK gives it web search and page-fetch tools. One run takes 30 to 90 seconds.</p>
        </div>

        <div className="agent-split">
          <div className="agent-live">
            <div className="box-title"><span>RUN IT YOURSELF</span><em>{liveStatus === "idle" ? "READY" : liveStatus.toUpperCase()}</em></div>
            <p className="agent-copy">Pick any of the 100 apps and run a fresh research pass right now. This is a real run, not a replay — it executes on our server with our API keys, so you need no setup at all. One run at a time; want to run it yourself instead? See the <a href={GITHUB_URL} target="_blank" rel="noreferrer">README</a>.</p>
            <div className="agent-live-controls">
              <select value={liveAppId} onChange={(event) => setLiveAppId(event.target.value)} disabled={liveStatus === "connecting" || liveStatus === "running"}>
                {apps.map((app) => <option value={app.id} key={app.id}>{app.name}</option>)}
              </select>
              <button type="button" onClick={runLiveAgent} disabled={liveStatus === "connecting" || liveStatus === "running"}>
                {liveStatus === "connecting" || liveStatus === "running" ? "Running…" : "Run agent"}
              </button>
            </div>
            {liveStatus === "error" && <div className="agent-live-error">{liveError}</div>}
            {(liveStatus === "running" || liveStatus === "connecting" || liveLines.length > 0) && (
              <div className="trace-body live">
                {liveLines.slice(-30).map((line, index) => (
                  <div className="trace-line" key={`${line.turn}-${index}`}>
                    <span>{String(line.turn).padStart(2, "0")}</span>
                    <b>{shortTool(line.tool)}</b>
                    <code>{line.arguments ? JSON.stringify(line.arguments) : `${line.result_len?.toLocaleString()} bytes returned`}</code>
                  </div>
                ))}
              </div>
            )}
            {liveResult && (
              <div className="agent-result">
                <h3>{liveResult.app_id}</h3>
                <p>{liveResult.findings.classification.one_liner.value}</p>
                <div className="detail-fields">
                  <div><span>Auth</span><b>{liveResult.findings.authentication.methods.value.map(titleCase).join(", ")}</b></div>
                  <div><span>Access</span><b>{titleCase(liveResult.findings.access.credential_access)}</b></div>
                  <div><span>API</span><b>{titleCase(liveResult.findings.api_surface.breadth)}</b></div>
                  <div><span>MCP</span><b>{titleCase(liveResult.findings.agent_interface.mcp)}</b></div>
                  <div><span>Verdict</span><b>{titleCase(liveResult.findings.buildability.verdict)}</b></div>
                </div>
              </div>
            )}
          </div>

          <div className="agent-sample">
            <div className="box-title"><span>SAMPLE OUTPUT</span><em>ONE PER CATEGORY</em></div>
            <p className="agent-copy">Pre-recorded runs, saved so they load instantly. Ten apps, one from each category.</p>
            <select value={sampleId} onChange={(event) => setSampleId(event.target.value)}>
              {sampleApps.map((app) => <option value={app.id} key={app.id}>{app.name} — {app.category}</option>)}
            </select>
            <div className="trace-body">
              {sampleTrace.slice(0, 20).map((line, index) => (
                <div className="trace-line" key={`${line.turn}-${index}`}>
                  <span>{String(line.turn).padStart(2, "0")}</span>
                  <b>{shortTool(line.tool)}</b>
                  <code>{line.arguments ? JSON.stringify(line.arguments) : `${line.result_len?.toLocaleString()} bytes returned`}</code>
                </div>
              ))}
              {sampleTrace.length > 20 && <p>+ {sampleTrace.length - 20} more events</p>}
            </div>
            {sampleRecord && (
              <div className="agent-result">
                <h3>{apps.find((app) => app.id === sampleId)?.name}</h3>
                <p>{sampleRecord.findings.classification.one_liner.value}</p>
                <div className="detail-fields">
                  <div><span>Auth</span><b>{sampleRecord.findings.authentication.methods.value.map(titleCase).join(", ")}</b></div>
                  <div><span>Access</span><b>{titleCase(sampleRecord.findings.access.credential_access)}</b></div>
                  <div><span>API</span><b>{titleCase(sampleRecord.findings.api_surface.breadth)}</b></div>
                  <div><span>MCP</span><b>{titleCase(sampleRecord.findings.agent_interface.mcp)}</b></div>
                  <div><span>Verdict</span><b>{titleCase(sampleRecord.findings.buildability.verdict)}</b></div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
