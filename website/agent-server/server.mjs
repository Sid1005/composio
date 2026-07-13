/**
 * Local sidecar for the "run it yourself" tab.
 *
 * The case-study site itself deploys to Cloudflare Workers, which cannot
 * spawn a Python process — so live agent runs are served by this small,
 * plain-Node HTTP server instead. It shells out to `python3 agent.py`,
 * tails the trace file the agent writes as it works, and streams both to
 * the browser over Server-Sent Events. Run it alongside `npm run dev`:
 *
 *   npm run agent-server
 *
 * See README.md for the full local-run setup (Assignment/.env, venv, etc).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8799);
const ASSIGNMENT_ROOT = process.env.ASSIGNMENT_ROOT || path.resolve(process.cwd(), "../agent");
const ASSIGNMENT_SRC = path.join(ASSIGNMENT_ROOT, "src");
const LOG_DIR = path.join(ASSIGNMENT_ROOT, "logs");
const DATA_DIR = path.join(ASSIGNMENT_ROOT, "data", "apps");
const PYTHON = process.env.PYTHON_BIN || path.join(ASSIGNMENT_ROOT, ".venv", "bin", "python3");

const slugify = (value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let running = false;

function sseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function tailTrace(tracePath, res, getStopped) {
  let lastLineCount = 0;
  while (!getStopped()) {
    try {
      const text = await readFile(tracePath, "utf8");
      const lines = text.split("\n").filter(Boolean);
      if (lines.length < lastLineCount) lastLineCount = 0; // file was truncated/restarted
      for (const line of lines.slice(lastLineCount)) {
        try {
          send(res, "trace", JSON.parse(line));
        } catch {
          // partial line write mid-flush; will be re-read whole next poll
        }
      }
      lastLineCount = lines.length;
    } catch {
      // trace file not created yet
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

async function handleRun(req, res, url) {
  const appName = url.searchParams.get("app");
  const appUrl = url.searchParams.get("url") || "";

  sseHeaders(res);

  if (!appName) {
    send(res, "run-error", { message: "Missing app name." });
    return res.end();
  }
  if (running) {
    send(res, "run-error", { message: "Another agent run is already in progress. Wait for it to finish." });
    return res.end();
  }

  running = true;
  const appId = slugify(appName);
  const tracePath = path.join(LOG_DIR, `${appId}-trace.jsonl`);
  const recordPath = path.join(DATA_DIR, `${appId}-research.json`);

  send(res, "status", { message: `Starting research agent for ${appName}…` });

  const args = ["-u", "agent.py", appName];
  if (appUrl) args.push(appUrl);
  const child = spawn(PYTHON, args, { cwd: ASSIGNMENT_SRC });

  let stopped = false;
  const tailPromise = tailTrace(tracePath, res, () => stopped);

  let stderrBuffer = "";
  let stderrFull = "";
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrFull += text;
    stderrBuffer += text;
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) send(res, "log", { line: line.trim() });
    }
  });

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
  });

  const cleanup = (req) => {
    stopped = true;
    if (!child.killed) child.kill();
    running = false;
  };
  req.on("close", () => cleanup(req));

  child.on("close", async (code) => {
    stopped = true;
    await tailPromise;
    running = false;

    if (code !== 0) {
      const tail = (stderrFull + "\n" + stdoutBuffer).trim().slice(-400);
      send(res, "run-error", {
        message: `Agent exited with an error (code ${code}).${tail ? " " + tail : ""}`,
      });
      return res.end();
    }

    try {
      await stat(recordPath);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      send(res, "result", record);
    } catch {
      send(res, "run-error", { message: "Agent finished but no output record was found." });
    }
    res.end();
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    return res.end();
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ ok: true, running }));
  }

  if (url.pathname === "/run") {
    return handleRun(req, res, url);
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Agent server listening on http://localhost:${PORT}`);
  console.log(`Spawning python3 agent.py from ${ASSIGNMENT_SRC}`);
});
