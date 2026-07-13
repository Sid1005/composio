# Website

The case study site. See the [root README](../README.md).

```bash
npm install
npm run data:sync
npm run dev
```

Live agent runs on the site are proxied to our hosted agent server (`app/api/run/route.ts`). To run one locally instead, start `npm run agent-server` and point the proxy at `http://localhost:8799`.
