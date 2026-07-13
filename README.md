# Composio toolkit research

An agent researched 100 apps to find out which can become AI agent toolkits today.

- Live case study: https://composio-siddharth.vercel.app
- The site's "Run the agent" tab runs the agent live on our server with our keys. No setup needed.

## What the agent is

One Python script (`agent/src/agent.py`). For each app it searches the web, reads the official docs and pricing pages, and writes one JSON record: auth methods, credential access, API surface, MCP support, and a buildability verdict. Every claim cites a URL and a quote. No evidence means "unknown", never a guess.

It needs two API keys because it has two parts:

- `OPENCODE_API_KEY`: the brain. DeepSeek V4 Flash, called through the opencode gateway.
- `COMPOSIO_API_KEY`: the hands. The Composio SDK provides the web search and page fetch tools.

## Run the agent yourself

```bash
cd agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # add your two API keys

cd src
python3 agent.py "Attio" "https://attio.com"   # one app
python3 run_batch.py --workers 5               # all 100, skips finished apps
```

Results land in `agent/data/apps/`, one JSON file per app. Full tool call traces are in `agent/logs/`.

## Run the website

```bash
cd website
npm install
npm run data:sync
npm run dev
```
