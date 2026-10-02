# 404 Grand Prix

An individual, server-timed question race for ACM orientation on **2 October 2026**. One Node 24 process serves React, Express and Socket.IO; SQLite WAL preserves events and race progress. Simultaneous answer bursts share a durable commit; every answer remains individually validated, recorded once and acknowledged only after that commit. The original briefs are preserved alongside the implementation.

## Windows / VS Code setup

Install Node.js 24 LTS and open this folder in VS Code. In its PowerShell terminal:

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run dev
```

Use `.cmd` on Windows if PowerShell blocks npm.ps1. Setup creates a private, ignored `.env`, random organizer credentials and a writable `./data` folder. Read `ADMIN_PASSWORD` in `.env` to log in; do not share that file. Setup preserves an existing configuration. Local development accepts passwords of at least 6 characters; production requires at least 12. Restart the development server after changing `.env`.

- Player: http://localhost:5173/join
- Projector: http://localhost:5173/display
- Organizer: http://localhost:5173/admin
- Health: http://localhost:3000/health

The organizer must open registration. Vite proxies API and sockets to port 3000, so sessions use the same browser origin. Do not mix `localhost` and `127.0.0.1` in a rehearsal: cookies belong to their host.

## Build, production and verification

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run load-test
npm.cmd run rehearse
```

Build includes client and server type checking. Load testing without `BASE_URL` starts a separate local server with its own timestamped SQLite file, then registers 150 players over 15 seconds, answers all 20 questions, retries answers and reconnects sockets. Its independent answer mapping verifies every score and all 3,000 saved answer records, including intentional timeouts. It reports acknowledgment p50/p95 and observed standings propagation. Target: p95 below 1 second and maximum observed propagation below 2 seconds. Test events do not replace or delete the real event.

`rehearse` uses installed Microsoft Edge (otherwise Playwright Chromium), separate browser contexts, 360/390 px viewports and an isolated database. It checks join, countdown, answers, double tap, refresh, offline recovery, backend restart, completion, freeze, CSV and bundle leakage. Screenshots and JSON reports go in ignored `artifacts/`. If Chromium is needed: `npx.cmd playwright install chromium`.

To test the actual Linux deployment runtime locally with Docker running:

```powershell
docker build -t 404-grand-prix:local .
node scripts/docker-smoke.mjs
node scripts/docker-load-test.mjs
```

The Docker load test defaults to **200 participants**, a server capped at **1 CPU and 512 MB**, and a separate Linux client on an isolated Docker network. It uses HTTP keep-alive and Socket.IO, measures a dedicated projector connection, and verifies every final score. Public updates contain the displayed top 15; each player's own rank is refreshed privately. Player state latency measures both answer acknowledgments and pushed snapshots, matching the UI. Set `PARTICIPANTS` to change the count. `LOAD_DOCKER_CLIENT=host` additionally diagnoses the Windows published-port path; neither mode establishes public-host capacity.

These commands create isolated temporary containers. Smoke tests preserve their database in `artifacts/`; the Docker load test preserves its own named volume and writes `artifacts/load-report-docker.json`. The Docker wrapper uses fresh HTTP connections because the Windows Docker port-forwarder stalled on reused HTTP connections in rehearsal; the native and public-host scripts use keep-alive by default. The Docker load test exercises the production image with secure cookies through a local HTTP test client; it does not verify a real HTTPS deployment. Windows filesystem and security scanning can affect local acknowledgment latency, so compare the native and Docker reports and always test the actual host.

For local production-build rehearsal, keep `NODE_ENV=development`, change `APP_BASE_URL` to `http://localhost:3000`, then:

```powershell
npm.cmd run build
npm.cmd start
```

Player, projector and admin then use port 3000. Production requires `NODE_ENV=production` and a public HTTPS `APP_BASE_URL`; cookies become Secure. `PORT` binds on `0.0.0.0`. Use `DB_PATH=/data/race.sqlite` on the persistent hosting mount, not on an ephemeral filesystem.

## Organizer runbook

1. Set the final public URL before printing or projecting the QR. Visit `/admin`, log in and click **Open registration**. Put `/display` on the projector. Let everyone scan and join.
2. Explain: correct answers earn 100; wrong answers/timeouts earn zero. Correct answers add server elapsed milliseconds; other answers add their full allowance. Scores sort descending, adjusted time ascending. Exact ties share competition rank. All 20 questions must be completed for prize eligibility; timeouts count as completed.
3. Click **Start race** and confirm. Five red lights count down over five seconds. New registrations close at the scheduled start. Each player advances independently as soon as their saved answer is acknowledged. Connected players submit through Socket.IO. A disconnected socket or missing acknowledgment falls back to HTTP using the same request ID, preserving exactly-once scoring.
4. Keep the server running. The total question allowance is 450 seconds; the global deadline is nine minutes after the countdown. Refreshing, hiding a tab or disconnecting cannot add time. The server catches up elapsed questions. Standings update at most once per second and remain **provisional**.
5. When everyone finishes, click **End & freeze results**. At the global deadline this happens automatically. Ending early leaves unfinished participants separately listed and ineligible. Frozen scores cannot change. Explanations become available to players after freezing.
6. Verify winners’ registration numbers against student IDs using the organizer CSV. The public display never shows registration numbers. If an exact tie crosses the top-10 cutoff, run an organizer tie-break before awarding gifts. The app flags the sporting tie and preserves it; it does not invent a tie-break ranking.
7. Download **QR PNG** and **Export CSV** from `/admin`. Create a fresh event only after freezing the current race (or before registration opens); confirmation is required. Earlier events and CSVs remain available. Reusing a browser for a fresh event creates a new session for that event.

The QR is black and white with a four-module white quiet zone and no embedded logo. `/api/qr` shows SVG; authenticated `/api/admin/qr.png` downloads PNG. Both derive from `APP_BASE_URL`. Changing that variable and restarting regenerates the QR. The written destination appears on the projector and organizer screen.

## Railway deployment

No public hosting credentials are included. Complete these steps in your Railway account:

For the supplied GitHub account, create an empty **private** repository named `404-grand-prix` (without adding a README), then publish the local `main` branch from this folder:

```powershell
git remote add origin https://github.com/RaoZainAli204/404-grand-prix.git
git push -u origin main
```

Complete GitHub’s sign-in prompt when asked. If an origin already exists, inspect `git remote -v` and use your existing repository rather than overwriting it. Keep the repository private because the server seed contains the answers. Installing and signing into the GitHub and Railway integrations is another way to give Codex access without sharing tokens in chat.

1. Create a private GitHub repository and push the source **including `package-lock.json`**; exclude `.env`, databases, `data/`, `artifacts/` and `node_modules/`. Create a Railway project with a GitHub repository service. Railway uses the root Dockerfile; `railway.json` configures `/health` and one replica. Alternatively deploy this Dockerfile with Railway CLI from an authenticated account.
2. In the service’s settings generate a public Railway HTTPS domain. Set `APP_BASE_URL=https://YOUR-DOMAIN` with no path. Set `PORT=3000`, `NODE_ENV=production`, `DB_PATH=/data/race.sqlite`, a unique `ADMIN_PASSWORD` of at least 12 characters, and a random `SESSION_SECRET` of at least 32 characters. Generate a secret locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Use different production credentials from development.
3. Add a persistent volume, attach it to this service and mount it at **`/data`**. Keep **one replica**. SQLite requires a single writer process. The image runs as root so it can write the mounted volume. Configure volume backups.
4. Disable **Serverless / service sleeping** in deployment settings for the event. Check the Free/Trial credit balance and resource limits; capacity is only known after testing. Apply changes and deploy. Native SQLite build tools are included in the build stage; `npm ci` uses the lockfile. Runtime initializes schema and snapshots the question bank without replacing existing events.
5. Open `https://YOUR-DOMAIN/health` and verify `{"ok":true}`. Open `/join`, `/display`, `/admin` directly. Log in, open registration and join from two phones. Verify the UI says Connected, and browser network tools show `/socket.io/` communicating over HTTPS/WebSocket. Download the QR and scan it; its destination must be the public `/join` URL.
6. Before the live event temporarily set `ENABLE_LOAD_TEST=true`, redeploy, and run the isolated load test against the host from this workstation:

```powershell
$env:BASE_URL = 'https://YOUR-DOMAIN'
$env:LOAD_ADMIN_PASSWORD = 'YOUR-PRODUCTION-ORGANIZER-PASSWORD'
npm.cmd run load-test
Remove-Item Env:BASE_URL, Env:LOAD_ADMIN_PASSWORD
```

7. Check `artifacts/load-report-remote.json`. Set `ENABLE_LOAD_TEST=false` again and redeploy **before registration**. Hosted test data stays archived, isolated from the current event. Rehearse several real phones, export CSV and restart once before the competition. Do not redeploy or change credentials during the live race.

Railway references: [Dockerfile deployment](https://docs.railway.com/builds/dockerfiles), [persistent volumes](https://docs.railway.com/volumes), [health checks](https://docs.railway.com/deployments/healthchecks), [Serverless and sleeping](https://docs.railway.com/deployments/serverless). The brief’s 30-minute deployment target depends on hosting access and package downloads; a local running server is not a deployment.

### Free hosting for the one-hour event

As checked on 2 October 2026, Railway offers a $0 Free plan with $1 of monthly credit; new accounts receive a $5 trial grant for up to 30 days. Free services allow up to 1 CPU, 512 MB RAM and a 0.5 GB persistent volume; Trial services allow more CPU/RAM. Use one service and one persistent volume, keep the credit balance above zero through rehearsal and the event, and remain on Free/Trial to meet the zero-payment constraint. This is a credit allowance, not unlimited free compute. Export the final CSV and retain a database backup after the event; trial volumes have limited retention. [Plans](https://docs.railway.com/pricing/plans), [trial](https://docs.railway.com/pricing/free-trial).

GitHub stores the private source. A direct Railway CLI upload also works without a GitHub repository connection. Install/run the official CLI with `npm.cmd exec --yes --package=@railway/cli -- railway`, then authenticate using `login --browserless`. The browser authorization is completed by the account owner; no password or token needs to be shared in chat.

Generate separate hosted credentials locally:

```powershell
npm.cmd run setup:production -- https://YOUR-SERVICE.up.railway.app
```

This writes the ignored `.env.production`, preserves the local testing password and preserves existing hosted credentials when rerun. Configure the service with these values and attach `/data` before the first race. `railway variable set KEY --stdin --skip-deploys` accepts a secret through stdin, avoiding command-line disclosure. Never upload either `.env` file. After configuring the service, `railway up --service SERVICE-ID --detach` uploads the source using `.gitignore` exclusions. The final public health, sockets, QR and **200-player load check** must pass before opening registration.

The event service is at **https://race-production-5cad.up.railway.app**. Its organizer password is `ADMIN_PASSWORD` in the ignored `.env.production`; `.env` remains the local testing configuration. The Railway project is [404-grand-prix](https://railway.com/project/624d43b6-c587-4f68-a830-d1826124373d), with one `race` service and a 500 MB volume mounted at `/data`.

For a future hosted rehearsal, temporarily enable load testing and use `node scripts/hosted-load-test.mjs --socket` for 200 players using the normal browser transport. The default mode mixes HTTP and Socket.IO; `--http` checks the HTTP fallback under a full burst. The fallback remains correct under load, but its 200-player timing result is slower than the normal socket path (see VERIFICATION.md). `scripts/hosted-smoke.mjs` checks the real HTTPS routes, cookies, Socket.IO, saved receipts, QR and CSV; `--verify-restart` checks its saved rehearsal session after a service restart. Disable load testing before registration. No GitHub repository connection is required for the current direct CLI deployment.

Render's free web services lose local SQLite data on restart/redeploy and cannot attach a persistent disk. Cloudflare's free SQLite Durable Objects can host a persistent race, but require adapting this Express/Socket.IO backend. Those are architectural changes to consider separately from the imminent event. [Render free limitations](https://render.com/docs/free), [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Existing VPS alternative

Use a Linux VPS with Docker/Compose. Put production values in its private `.env`, including public HTTPS `APP_BASE_URL`. Run:

```sh
docker compose up -d --build
docker compose logs --tail=50 race
curl http://127.0.0.1:3000/health
```

The included Compose service binds port 3000 to loopback and persists SQLite in the named `race-data` volume. Put Caddy or Nginx on the same VPS in front of `127.0.0.1:3000`; configure DNS and TLS for your domain and pass WebSocket upgrades. Example host Caddyfile:

```caddyfile
race.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Test HTTPS, Socket.IO, actual QR and load against this public origin. Preserve the volume across rebuilds; **never run `docker compose down -v`** on the competition deployment.

## Recovery, privacy and fallback

Restart the same Node process with the same database mount and secrets. Scheduled start/end, orders, issue/deadline times, answers and score totals recover from SQLite. The scheduler and every resume/submission catch up expired questions using their original deadlines. Browser cookies resume the same participant. A duplicate registration in another browser never returns their session; use the original device/browser. Clearing cookies loses that browser’s access and needs organizer assistance; there is no insecure registration-number login.

Keep a host volume backup and download final CSV before maintenance. SQLite uses WAL with `synchronous=FULL` and commits answers before acknowledging them. See [SQLite synchronous behavior](https://www.sqlite.org/pragma.html#pragma_synchronous). Stop the service before copying a database manually, or use SQLite’s backup API: do not copy only the `.sqlite` file during WAL writes. Public payloads contain names and public row IDs, scores, ranks and progress. Private keys and future questions stay on the server. Registration/session hashes stay out of public responses and the client bundle; player explanations appear only after close. CSV cells neutralize spreadsheet formula prefixes. Production cookies are HttpOnly, Secure and SameSite Strict. Organizer actions require server authentication and cross-origin browser writes are rejected. IP join limits allow many students behind one venue Wi-Fi address; answer limits apply per participant. No social login or question editor is included.

Short timers, visual puzzles and shuffled options reduce convenient cheating; the app is not AI-proof. Tab switching does not disqualify anyone. Network delay consumes real server time; test venue Wi-Fi, which a server load test cannot validate.

Before presenting, rehearse on **5–10 real phones**, scan the **actual projected QR from the back of the room**, check readability, connection recovery and final CSV. If core checks fail or public hosting/networking is unavailable, use the same questions as a team quiz in slides with manual scoring. The private `server/seed.ts` contains all answers and explanations for that fallback. A LAN rehearsal can use a verified reachable PC address in `APP_BASE_URL` with development cookies; do not publish a LAN QR unless venue access and routing have been tested.

Verification results are recorded in `VERIFICATION.md`; hosted results must be added only after testing the real deployment.
