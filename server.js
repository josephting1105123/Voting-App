'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { createStore } = require('./src/store');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// Per-IP limits. Sized so a whole classroom or office behind one NAT address can use the app together.
const CREATE_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 }; // successful poll creations per IP per window
const MAX_ACTIVE_POLLS_PER_IP = 30; // live polls one IP may hold at once (enforced in the store)
const JOIN_LIMIT = { max: 300, windowMs: 60 * 1000 }; // per IP per window; a join costs 1, a failed join costs 2
const MAX_SOCKETS_PER_IP = 1000; // concurrent Socket.IO connections per IP
// Per socket (not per IP): events allowed in one window.
// Every event counts against FLOOD; past it the event is dropped and the socket is disconnected.
// The one exception: on a socket that has authenticated as an admin, events named admin:* count against the
// separate, larger ADMIN_FLOOD instead, and going over that never disconnects the host. The event is refused with
// ADMIN_SLOW_DOWN (if it carried an ack) and the window moves on. Non-admin events on an admin socket still count
// against FLOOD, so an admin socket can't be used as a flood channel for voter events.
const FLOOD = { maxEvents: 30, windowMs: 10 * 1000 };
const ADMIN_FLOOD = { maxEvents: 1000, windowMs: 10 * 1000 };
const ADMIN_SLOW_DOWN = 'Too many actions — slow down a moment';
const HOST_PATTERN = /^[a-z0-9.\-:[\]]+$/i;
// State pushes to a poll's admin and voters are held for this long and merged, so a burst of votes or approvals
// costs one broadcast instead of one per event. Acks are never delayed.
const FLUSH_MS = 150;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ---- client IP ----
 * Behind a proxy the real client is the Nth entry from the RIGHT of X-Forwarded-For (N = TRUST_PROXY_HOPS,
 * default 1). Entries further left are whatever the client chose to send, so they are never used.
 * With no proxy in front, set TRUST_PROXY_HOPS=0 so a spoofed header can't pick the key. */

function proxyHops() {
  const n = Number(process.env.TRUST_PROXY_HOPS || 1);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

function clientIp(headers, remoteAddress, hops = proxyHops()) {
  const raw = headers ? headers['x-forwarded-for'] : undefined;
  const header = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(',') : '';
  let ip = '';
  if (hops > 0 && header) {
    const parts = header
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= hops) ip = parts[parts.length - hops];
  }
  if (!ip) ip = remoteAddress || 'unknown';
  return String(ip).replace(/^::ffff:/i, '').slice(0, 64);
}

let ipLogged = false;
function logIpOnce(headers, chosen) {
  if (ipLogged) return;
  ipLogged = true;
  const raw = headers ? headers['x-forwarded-for'] : undefined;
  console.log(`[ip] xff=${raw === undefined ? '(none)' : raw} chosen=${chosen}`);
}

function requestIp(req) {
  const ip = clientIp(req.headers, req.socket && req.socket.remoteAddress);
  logIpOnce(req.headers, ip);
  return ip;
}

function socketIp(socket) {
  const ip = clientIp(socket.handshake.headers, socket.handshake.address);
  logIpOnce(socket.handshake.headers, ip);
  return ip;
}

/* ---- fixed-window rate limiter ---- */

function createLimiter() {
  const entries = new Map(); // key -> { count, resetAt }
  function entry(key, windowMs) {
    const t = Date.now();
    let e = entries.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + windowMs };
      entries.set(key, e);
    }
    return e;
  }
  return {
    allow: (key, max, windowMs) => entry(key, windowMs).count < max,
    hit(key, windowMs, cost = 1) {
      entry(key, windowMs).count += cost;
    },
    prune() {
      const t = Date.now();
      for (const [key, e] of entries) if (e.resetAt <= t) entries.delete(key);
    },
    size: () => entries.size,
  };
}

/* ---- HTTP ---- */

function securityHeaders(req, res, next) {
  // Socket.IO needs an explicit ws/wss source on browsers that don't treat 'self' as covering websockets.
  // Host comes from the request, so it is validated before it goes into a header.
  let connect = "'self'";
  const host = req.headers.host;
  if (typeof host === 'string' && host.length <= 255 && HOST_PATTERN.test(host)) {
    connect += ` wss://${host}`;
    if (!req.secure) connect += ` ws://${host}`;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; connect-src ${connect}; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  );
  next();
}

function createApp(store, limiter = createLimiter()) {
  const app = express();
  app.set('trust proxy', proxyHops());
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  app.use(express.json({ limit: '10kb' }));

  app.get('/healthz', (req, res) => {
    res.status(200).type('text/plain').send('ok');
  });

  app.post('/api/polls', (req, res) => {
    const ip = requestIp(req);
    const key = `create:${ip}`;
    if (!limiter.allow(key, CREATE_LIMIT.max, CREATE_LIMIT.windowMs)) {
      return res.status(429).json({ error: 'Too many polls created from your network. Try again in a few minutes.' });
    }
    const body = isPlainObject(req.body) ? req.body : {};
    const result = store.createPoll(
      {
        title: body.title,
        options: body.options,
        multi: body.multi,
        maxChoices: body.maxChoices,
        anonymous: body.anonymous,
      },
      ip
    );
    if (!result.ok) return res.status(result.code === 'ip_limit' ? 429 : 400).json({ error: result.error });
    limiter.hit(key, CREATE_LIMIT.windowMs); // only successful creations count against the limit
    res.status(201).json({ pin: result.pin, adminToken: result.adminToken });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(err);
    const message = status === 413 ? 'Request too large' : status < 500 ? 'Invalid request' : 'Server error';
    res.status(status).json({ error: message });
  });

  return app;
}

/* ---- Socket.IO ---- */

function attachSockets(io, store, limiter) {
  const adminRoom = (poll) => `admin:${poll.id}`;
  const voterRoom = (poll, voter) => `voter:${poll.id}:${voter.id}`;

  function emitVoterState(poll, voter) {
    io.to(voterRoom(poll, voter)).emit('voter:state', store.voterView(poll, voter));
  }

  // The one place state leaves the server after a poll mutation. Mutations call scheduleFlush(), which merges
  // what needs sending into one pending entry per poll; the first call starts a FLUSH_MS timer and flush() then
  // sends everything the merged entry asks for, using the poll's state at that moment:
  //   admin:       one admin:state to the admin room
  //   voters:      voter:state to each of these voters. They are held as objects, so a just-rejected voter
  //                (already deleted from the poll) still gets their "declined" view
  //   allVoters:   voter:state to every voter currently in the poll
  //   votedVoters: if results are live, voter:state to every voter who has voted (only they can see results)
  const pendingFlush = new Map(); // poll id -> { poll, admin, all, voted, voters: Set<voter>, timer }

  function scheduleFlush(poll, what) {
    let entry = pendingFlush.get(poll.id);
    if (!entry) {
      entry = { poll, admin: false, all: false, voted: false, voters: new Set(), timer: null };
      entry.timer = setTimeout(() => flush(poll.id), FLUSH_MS);
      pendingFlush.set(poll.id, entry);
    }
    if (what.admin) entry.admin = true;
    if (what.allVoters) entry.all = true;
    if (what.votedVoters) entry.voted = true;
    if (what.voters) for (const voter of what.voters) entry.voters.add(voter);
  }

  function flush(pollId) {
    const entry = pendingFlush.get(pollId);
    if (!entry) return;
    pendingFlush.delete(pollId);
    const { poll } = entry;
    try {
      if (store.getByAdminToken(poll.adminToken) !== poll) return; // swept before we got to it
      if (entry.admin) io.to(adminRoom(poll)).emit('admin:state', store.adminView(poll));
      const sent = new Set();
      const send = (voter) => {
        if (sent.has(voter)) return;
        sent.add(voter);
        emitVoterState(poll, voter);
      };
      if (entry.all) for (const voter of poll.voters.values()) send(voter);
      for (const voter of entry.voters) send(voter);
      if (entry.voted && poll.live) {
        for (const voter of poll.voters.values()) if (voter.hasVoted) send(voter);
      }
    } catch (err) {
      console.error('flush error:', err);
    }
  }

  const socketsPerIp = new Map();

  io.use((socket, next) => {
    const ip = socketIp(socket);
    if ((socketsPerIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP) return next(new Error('Too many connections'));
    socket.data.ip = ip;
    next();
  });

  io.on('connection', (socket) => {
    const ip = socket.data.ip;
    socketsPerIp.set(ip, (socketsPerIp.get(ip) || 0) + 1);
    socket.on('disconnect', () => {
      const left = (socketsPerIp.get(ip) || 1) - 1;
      if (left > 0) socketsPerIp.set(ip, left);
      else socketsPerIp.delete(ip);
    });

    // Flood guard, with two independent fixed-window counters (see FLOOD / ADMIN_FLOOD at the top).
    // The admin counter only applies to admin:* events on a socket that has already authenticated.
    const counters = { voter: { start: Date.now(), n: 0 }, admin: { start: Date.now(), n: 0 } };
    function overBudget(counter, budget) {
      const t = Date.now();
      if (t - counter.start > budget.windowMs) {
        counter.start = t;
        counter.n = 0;
      }
      counter.n += 1;
      return counter.n > budget.maxEvents;
    }
    socket.use((packet, next) => {
      const isAdminEvent = Boolean(socket.data.adminToken) && typeof packet[0] === 'string' && packet[0].startsWith('admin:');
      if (isAdminEvent) {
        if (overBudget(counters.admin, ADMIN_FLOOD)) {
          // Socket.IO appends the ack callback as the last argument, so it can be answered from here.
          const ack = packet[packet.length - 1];
          if (typeof ack === 'function') ack({ ok: false, error: ADMIN_SLOW_DOWN });
          return; // dropped, but the host stays connected
        }
      } else if (overBudget(counters.voter, FLOOD)) {
        socket.disconnect(true);
        return; // never call next(): the event is not handled
      }
      next();
    });

    // Registers a handler that always receives (object, ack). Calls without an ack callback are ignored.
    function on(event, handler) {
      socket.on(event, (arg, maybeAck) => {
        let data = arg;
        let ack = maybeAck;
        if (typeof arg === 'function' && maybeAck === undefined) {
          ack = arg;
          data = {};
        }
        if (typeof ack !== 'function') return;
        try {
          handler(isPlainObject(data) ? data : {}, ack);
        } catch (err) {
          console.error(`handler error (${event}):`, err);
          ack({ ok: false, error: 'Server error' });
        }
      });
    }

    function enterVoterRoom(poll, voter) {
      const room = voterRoom(poll, voter);
      if (socket.data.voterRoom && socket.data.voterRoom !== room) socket.leave(socket.data.voterRoom);
      socket.join(room);
      socket.data.voterRoom = room;
      socket.data.voterToken = voter.token;
    }

    // Wraps an admin command: uses the token remembered from admin:auth, never one sent with the command.
    function adminCommand(run) {
      return (data, ack) => {
        const token = socket.data.adminToken;
        if (!token) return ack({ ok: false, error: 'Not authenticated' });
        const result = run(token, data);
        if (!result.ok) return ack({ ok: false, error: result.error });
        ack({ ok: true, ...(result.ack || {}) }); // the answer is immediate; the state push is coalesced
        scheduleFlush(result.poll, result.notify || { admin: true });
      };
    }

    on('admin:auth', (data, ack) => {
      const token = typeof data.token === 'string' ? data.token : '';
      const poll = store.getByAdminToken(token);
      if (!poll) return ack({ ok: false, error: 'not found' });
      const room = adminRoom(poll);
      if (socket.data.adminRoom && socket.data.adminRoom !== room) socket.leave(socket.data.adminRoom);
      socket.join(room);
      socket.data.adminRoom = room;
      socket.data.adminToken = token;
      ack({ ok: true, state: store.adminView(poll) });
    });

    on(
      'admin:decide',
      adminCommand((token, data) => {
        if (typeof data.voterId !== 'string' || typeof data.approve !== 'boolean') {
          return { ok: false, error: 'Invalid request' };
        }
        const result = store.decide(token, data.voterId, data.approve);
        // Only the admin and the voter who was decided on see anything change.
        return result.ok ? { ...result, notify: { admin: true, voters: [result.voter] } } : result;
      })
    );

    on(
      'admin:approveAll',
      adminCommand((token) => {
        const result = store.approveAll(token);
        // One state push for the whole batch; the ack carries how many people were let in.
        return result.ok ? { ...result, ack: { count: result.count }, notify: { admin: true, voters: result.voters } } : result;
      })
    );

    on(
      'admin:setLive',
      adminCommand((token, data) => {
        if (typeof data.live !== 'boolean') return { ok: false, error: 'Invalid request' };
        const result = store.setLive(token, data.live);
        return result.ok ? { ...result, notify: { admin: true, allVoters: true } } : result;
      })
    );

    on(
      'admin:setPaused',
      adminCommand((token, data) => {
        if (typeof data.paused !== 'boolean') return { ok: false, error: 'Invalid request' };
        const result = store.setPaused(token, data.paused);
        return result.ok ? { ...result, notify: { admin: true, allVoters: true } } : result;
      })
    );

    on(
      'admin:edit',
      adminCommand((token, data) => {
        const result = store.editPoll(token, {
          title: data.title,
          options: data.options,
          multi: data.multi,
          maxChoices: data.maxChoices,
        });
        return result.ok ? { ...result, ack: { reset: result.reset }, notify: { admin: true, allVoters: true } } : result;
      })
    );

    on(
      'admin:close',
      adminCommand((token) => {
        const result = store.closePoll(token);
        return result.ok ? { ...result, notify: { admin: true, allVoters: true } } : result;
      })
    );

    on('voter:join', (data, ack) => {
      const key = `join:${socket.data.ip}`;
      if (!limiter.allow(key, JOIN_LIMIT.max, JOIN_LIMIT.windowMs)) {
        return ack({ ok: false, error: 'Too many attempts. Wait a minute and try again.' });
      }
      const result = store.joinPoll(data.pin, data.name, data.joinKey);
      limiter.hit(key, JOIN_LIMIT.windowMs, result.ok ? 1 : 2);
      if (!result.ok) return ack({ ok: false, error: result.error });
      enterVoterRoom(result.poll, result.voter);
      ack({ ok: true, voterToken: result.voterToken });
      // Admin sees the new pending entry; the joiner gets their first voter:state.
      scheduleFlush(result.poll, { admin: true, voters: [result.voter] });
    });

    on('voter:resume', (data, ack) => {
      const found = store.getVoterByToken(typeof data.voterToken === 'string' ? data.voterToken : '');
      if (!found) return ack({ ok: false, error: 'not found' });
      enterVoterRoom(found.poll, found.voter);
      ack({ ok: true, state: store.voterView(found.poll, found.voter) });
    });

    on('voter:vote', (data, ack) => {
      const token = socket.data.voterToken;
      if (!token) return ack({ ok: false, error: 'Join the poll first' });
      const result = store.vote(token, data.choices, data.revision);
      if (!result.ok) return ack({ ok: false, error: result.error });
      ack({ ok: true });
      // A vote changes the admin's counts and the voter's own screen; once results are live, every voter who
      // has already voted can see the counts change too.
      scheduleFlush(result.poll, { admin: true, voters: [result.voter], votedVoters: true });
    });
  });

  // Drops anything still waiting to be sent (used when the server closes).
  return {
    stop() {
      for (const entry of pendingFlush.values()) clearTimeout(entry.timer);
      pendingFlush.clear();
    },
  };
}

function start(port = PORT) {
  const store = createStore({ limits: { POLLS_PER_IP: MAX_ACTIVE_POLLS_PER_IP } });
  const limiter = createLimiter();
  const app = createApp(store, limiter);
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 10_000 });
  const sockets = attachSockets(io, store, limiter);

  const sweepTimer = setInterval(() => {
    limiter.prune();
    const removed = store.sweep();
    if (removed > 0) console.log(`Expired ${removed} poll(s)`);
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      clearInterval(sweepTimer);
      reject(err);
    });
    server.listen(Number(port), () => {
      const actualPort = server.address().port;
      let closing = null;
      resolve({
        server,
        io,
        store,
        url: `http://127.0.0.1:${actualPort}`,
        close() {
          if (!closing) {
            clearInterval(sweepTimer);
            sockets.stop();
            closing = new Promise((done) => {
              io.close(() => done());
              // Keep-alive HTTP connections would otherwise hold the close open.
              setImmediate(() => {
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
              });
            });
          }
          return closing;
        },
      });
    });
  });
}

if (require.main === module) {
  start()
    .then(({ url }) => console.log(`Quick Vote listening on ${url}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { start, createApp, clientIp };
