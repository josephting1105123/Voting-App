# Quick Vote

A small real-time voting app. Someone creates a poll and gets a 6-digit PIN plus a private admin link. Voters join with the PIN and a name, the admin lets them in, and everyone votes from their phone. The admin sees results update live and decides whether voters see them too.

Node, Express and Socket.IO on the server, plain HTML/CSS/JS on the front end (no build step). All state lives in memory. The page is an installable PWA.

## Run it

```
npm install
npm start
```

Open http://localhost:3000. Set `PORT` to use a different port. Needs Node 24.

## Test

```
npm test
```

`test/store.test.js` covers the poll logic with an injected clock. `test/e2e.test.js` boots the server on a random port and drives it with `socket.io-client`, including the rate limits and flood protection.

## Deploy to Render

1. Push this repo to GitHub/GitLab.
2. In Render, create a new Blueprint (or Web Service) from the repo. `render.yaml` is picked up automatically: free plan, `npm ci`, `npm start`, health check on `/healthz`.
3. After the first deploy, open the service logs and find the line `[ip] xff=... chosen=...` (printed once, on the first request). `chosen` should be your own public IP. If it is a Render or CDN address instead, raise `TRUST_PROXY_HOPS` (see below) until it matches.

## Limits to know about

**Data is in memory only.** A restart wipes every poll. Polls also expire 24 hours after creation, and the server holds at most 2000 polls and 50,000 voters at a time.

**The free tier sleeps.** Render's free web service spins down after about 15 minutes with no traffic, and a spin-down is a restart, so every poll is lost. An open admin or voter page pings `/healthz` every 4 minutes to keep the server awake. That means: keep the admin page open while people vote, and expect polls to disappear if nobody has a poll page open for 15 minutes. Cold starts after a sleep take around a minute.

**The admin link is the only credential.** `/admin.html#<token>` is the whole login. Anyone with the link is the admin.

**Anonymous polls.** The server never stores who picked what. The admin still sees which voters have submitted and the running totals, so in a very small poll, watching the screen as each vote lands can reveal a choice.

## Rate limits

Limits are per client IP, and sized so a classroom or office sharing one address can use the app together. They are named constants at the top of `server.js`.

| What | Limit |
| --- | --- |
| Polls created | 10 per 10 minutes, 30 live polls at once |
| Joins (`voter:join`) | 300 per minute; a failed join counts double |
| Concurrent Socket.IO connections | 1000 |
| Events on one voter socket | 30 per 10 seconds, then the socket is dropped |
| Events on an admin socket | 1000 per 10 seconds. Past that, actions are refused with "Too many actions — slow down a moment" and the connection stays up |

Per poll: 500 voters, counting people waiting for approval and approved voters together. Rejected voters are deleted and free their slot. There is no separate limit on how many can be waiting.

### `TRUST_PROXY_HOPS`

The client IP comes from `X-Forwarded-For`, taking the entry that many hops from the **right** (the end the proxy writes to, which a client can't forge). The default is `1`: one proxy in front.

- **Render: set `TRUST_PROXY_HOPS=3`.** Render's header arrives as `client, cloudflare-edge, render-load-balancer` (checked 2026-10-17). With the default of 1, every user is counted as Render's load balancer and they all share one rate-limit bucket. `render.yaml` sets it; a service created by hand in the dashboard needs it added under Environment.
- Behind one proxy: leave it unset.
- Running with no proxy at all (local, or a bare VM): set `TRUST_PROXY_HOPS=0`. Otherwise a client can send its own `X-Forwarded-For` and pick which IP it is counted as.

If the header is missing or has fewer entries than the hop count, the connection's own address is used. Check the `[ip]` log line after deploying to confirm the setting.
