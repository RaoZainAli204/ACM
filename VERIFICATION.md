# Verification — 2 October 2026 (Asia/Karachi)

The app is deployed at **https://race-production-5cad.up.railway.app** using a direct Railway CLI upload. The account owner completed browser sign-in. No paid plan upgrade was selected. The project has one `race` service, sleeping disabled and a 500 MB persistent volume mounted at `/data`. GitHub publishing is separate from this working deployment.

## Functional verification

- Node 24.12.0 / npm 11.6.2; production build and client/server type checks pass.
- **18 automated tests pass**, including exactly-once scoring, concurrent retries, deadlines, refresh/restart, shuffled questions/options, immutable banks, registration uniqueness, ties/eligibility, authentication, CSV formulas and private-data boundaries. The additional integration test verifies that a player below position 15 receives private rank changes while public updates remain bounded to 15 rows.
- Browser rehearsal passes at 360/390 px: synchronized countdown, Socket.IO answer submission, double tap, a deliberately lost socket acknowledgment with HTTP replay, wrong-answer handling, refresh, offline catch-up, backend restart, all 20 questions, freezing, CSV, QR PNG and bundle privacy. Expected score 1,700 matches; no browser errors.
- Real hosted HTTPS smoke passes for health, all three routes, organizer authentication, Secure/HttpOnly cookies, authenticated WebSocket gameplay, saved-answer replay, QR PNG and CSV export. Isolated test events preserve the real event.
- The final Docker release-image smoke passes for health, direct routes, secure cookies, WebSocket access, QR PNG and database/session recovery after a container restart.
- Final Railway release is active. Its JavaScript bundle matches the verified local build. Load-test event creation returns 403, private diagnostics return 404, and registration is closed with zero real participants. The saved hosted player cookie, score and progress survived redeployment with the persistent `/data` volume.
- SQLite retains WAL and `synchronous=FULL`; acknowledgments follow committed answers. Private `.env`, `.env.production`, databases, saved test cookies and artifacts are ignored by Git and deployment uploads.

## Hosted capacity

Tests ran against the real Railway HTTPS URL from this workstation. Each run registered 200 players over a scheduled 15-second window, reached a peak of **200 concurrent submissions**, completed all 20 questions and verified every final score independently. Each stored **4,000 answer records**, including four intentional timeouts; retries and reconnections preserved scores.

| Hosted measurement | Normal Socket.IO path | Mixed HTTP / Socket.IO | All-HTTP fallback |
| --- | ---: | ---: | ---: |
| Answer acknowledgment p95 | **808.81 ms** | **565.79 ms** | 2,051.65 ms |
| Maximum projector propagation | **1,645 ms** | **1,427 ms** | 2,602 ms |
| Maximum private state propagation | **1,275 ms** | **1,736 ms** | 2,715 ms |
| Independently verified scores | 200 / 200 | 200 / 200 | 200 / 200 |
| Errors in scoring/persistence | 0 | 0 | 0 |

The normal and mixed paths meet the acknowledgment target below 1,000 ms and propagation target below 2,000 ms. The all-HTTP run preserves correctness but misses latency targets under a full 200-player burst. The browser therefore prefers Socket.IO and falls back to HTTP with the same request ID after a missing acknowledgment or disconnect. These measurements do not establish an unlimited request rate or validate venue Wi-Fi.

## Docker diagnosis and validation

Earlier tests missed latency targets or timed out. Large full-table broadcasts sent all participants to every socket. Public traffic now sends the displayed top 15, each player's rank updates privately, and healthy connected browsers use polling only when updates become stale. A separate Linux client removes the Windows published-port path from the server benchmark.

A subsequent 1-CPU / 512-MB Docker run completed all 4,000 answers and verified 200 scores: acknowledgment p95 258.78 ms and maximum projector propagation 1,177 ms. An extra measurement of pushed player snapshots alone reached 6,647 ms; the final state metric also observes private answer acknowledgments, which the UI renders immediately. Repeated constrained Docker runs still hit intermittent HTTP timeouts, including HTTP duplicate/reconnect checks during a socket-answer run. That local diagnostic issue remains unresolved and is not treated as a capacity pass. The actual Railway normal and mixed paths passed the full correctness and timing checks above. The final release-image smoke result is in `docker-smoke-report.json`.

## Evidence and event handoff

Raw reports are in ignored `artifacts/`: `rehearsal-report.json`, `hosted-smoke-report.json`, hosted load reports, `load-report-docker.json` and `docker-smoke-report.json`. The QR image is `artifacts/public-join-qr.png`. Local rehearsal databases and named Docker volumes remain isolated from the real event.

The hosted organizer password is `ADMIN_PASSWORD` in private `.env.production`. The local `.env` retains the user's local testing password. The public event is kept closed and empty until the organizer opens registration. No real competition records were deleted.

Before the event, rehearse on 5–10 real phones, verify answer speed and reconnect behavior on venue Wi-Fi, and scan the actual projected QR from the back of the room. At the finish, freeze results and export CSV before stopping the service. Railway Free/Trial compute is credit limited; keep the account on Free/Trial and check its remaining balance. No GitHub repository has been pushed yet.
