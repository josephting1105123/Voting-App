'use strict';

const http = require('node:http');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { start, clientIp } = require('../server');

// Remembers the latest payload of an event and lets a test wait for one matching a predicate.
function track(socket, event) {
  let last;
  const waiters = new Set();
  socket.on(event, (data) => {
    last = data;
    for (const w of [...waiters]) {
      if (w.pred(data)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(data);
      }
    }
  });
  return {
    last: () => last,
    waitFor(pred, ms = 3000) {
      if (last !== undefined && pred(last)) return Promise.resolve(last);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`timed out waiting for ${event}; last = ${JSON.stringify(last)}`));
        }, ms);
        waiters.add(w);
      });
    },
  };
}

function ask(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 3000);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('poll lifecycle over HTTP and Socket.IO', { timeout: 30000 }, async (t) => {
  const app = await start(0);
  const sockets = [];
  const connectSocket = async () => {
    const s = await open(app.url);
    sockets.push(s);
    return s;
  };

  try {
    let pin;
    let adminToken;
    let admin;
    let adminState;
    let voter;
    let voterState;
    let voterToken;
    let voterLeaks = 0;

    await t.test('GET /healthz returns 200 ok', async () => {
      const res = await fetch(`${app.url}/healthz`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'ok');
    });

    await t.test('serves the home page', async () => {
      const res = await fetch(`${app.url}/`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Quick Vote/);
    });

    await t.test('POST /api/polls validates input', async () => {
      const bad = await postJson(`${app.url}/api/polls`, { title: '', options: ['a'] });
      assert.equal(bad.status, 400);
      assert.equal(typeof bad.body.error, 'string');

      const malformed = await fetch(`${app.url}/api/polls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{nope',
      });
      assert.equal(malformed.status, 400);
      assert.equal(typeof (await malformed.json()).error, 'string');
    });

    await t.test('POST /api/polls creates a poll', async () => {
      const res = await postJson(`${app.url}/api/polls`, {
        title: 'Lunch?',
        options: ['Pizza', 'Sushi', 'Tacos'],
        multi: false,
        anonymous: false,
      });
      assert.equal(res.status, 201);
      assert.match(res.body.pin, /^\d{6}$/);
      assert.match(res.body.adminToken, /^[0-9a-f]{48}$/);
      pin = res.body.pin;
      adminToken = res.body.adminToken;
    });

    await t.test('admin commands are refused before admin:auth, and bad tokens fail', async () => {
      const stranger = await connectSocket();
      assert.equal((await ask(stranger, 'admin:close', {})).ok, false);
      assert.equal((await ask(stranger, 'admin:auth', { token: 'nope' })).ok, false);
      assert.equal((await ask(stranger, 'admin:auth', null)).ok, false);
      assert.equal((await ask(stranger, 'voter:vote', { choices: [0] })).ok, false);
      assert.equal((await ask(stranger, 'voter:resume', { voterToken: 'nope' })).ok, false);
    });

    await t.test('admin authenticates and gets the initial state', async () => {
      admin = await connectSocket();
      adminState = track(admin, 'admin:state');
      const res = await ask(admin, 'admin:auth', { token: adminToken });
      assert.equal(res.ok, true);
      assert.equal(res.state.pin, pin);
      assert.equal(res.state.title, 'Lunch?');
      assert.deepEqual(res.state.pending, []);
      assert.equal(res.state.live, false);
    });

    await t.test('a joining voter shows up as pending for the admin', async () => {
      voter = await connectSocket();
      voterState = track(voter, 'voter:state');
      voter.on('admin:state', () => {
        voterLeaks += 1;
      });
      const res = await ask(voter, 'voter:join', { pin, name: 'Alice' });
      assert.equal(res.ok, true);
      assert.match(res.voterToken, /^[0-9a-f]{48}$/);
      voterToken = res.voterToken;

      const state = await adminState.waitFor((s) => s.pending.length === 1);
      assert.equal(state.pending[0].name, 'Alice');
      const mine = await voterState.waitFor((s) => s.status === 'pending');
      assert.equal(mine.name, 'Alice');
    });

    await t.test('a duplicate name is refused', async () => {
      const other = await connectSocket();
      const res = await ask(other, 'voter:join', { pin, name: 'alice' });
      assert.equal(res.ok, false);
      const bad = await ask(other, 'voter:join', { pin: '000000', name: 'Bob' });
      assert.equal(bad.ok, false);
    });

    await t.test('approving moves the voter to approved', async () => {
      const voterId = adminState.last().pending[0].id;
      assert.equal((await ask(admin, 'admin:decide', { voterId, approve: true })).ok, true);
      const mine = await voterState.waitFor((s) => s.status === 'approved');
      assert.deepEqual(
        mine.options.map((o) => o.text),
        ['Pizza', 'Sushi', 'Tacos']
      );
      const state = await adminState.waitFor((s) => s.pending.length === 0 && s.approved.length === 1);
      assert.equal(state.approved[0].hasVoted, false);
    });

    await t.test('voting updates the admin counts and the voter record', async () => {
      const sushi = voterState.last().options[1].id;
      assert.equal((await ask(voter, 'voter:vote', { choices: [sushi] })).ok, true);
      const state = await adminState.waitFor((s) => s.totalVoted === 1);
      assert.equal(state.options.find((o) => o.id === sushi).count, 1);
      assert.equal(state.approved[0].hasVoted, true);
      assert.deepEqual(state.approved[0].choices, [sushi]);

      const mine = await voterState.waitFor((s) => s.hasVoted);
      assert.equal(mine.results, null); // live is still off

      const again = await ask(voter, 'voter:vote', { choices: [0] });
      assert.equal(again.ok, false);
    });

    await t.test('toggling live shows and hides results for the voter', async () => {
      assert.equal((await ask(admin, 'admin:setLive', { live: true })).ok, true);
      const shown = await voterState.waitFor((s) => s.results !== null);
      assert.equal(shown.results.totalVoted, 1);
      assert.deepEqual(
        shown.results.options.map((o) => o.count),
        [0, 1, 0]
      );
      await adminState.waitFor((s) => s.live === true);

      assert.equal((await ask(admin, 'admin:setLive', { live: false })).ok, true);
      await voterState.waitFor((s) => s.results === null);
      await adminState.waitFor((s) => s.live === false);

      assert.equal((await ask(admin, 'admin:setLive', { live: 'yes' })).ok, false);
    });

    await t.test('a voter can resume with their token on a new socket', async () => {
      const again = await connectSocket();
      const res = await ask(again, 'voter:resume', { voterToken });
      assert.equal(res.ok, true);
      assert.equal(res.state.status, 'approved');
      assert.equal(res.state.hasVoted, true);
      assert.equal(res.state.results, null);
    });

    await t.test('a rejected voter sees the rejection', async () => {
      const bob = await connectSocket();
      const bobState = track(bob, 'voter:state');
      assert.equal((await ask(bob, 'voter:join', { pin, name: 'Bob' })).ok, true);
      const pendingBob = (await adminState.waitFor((s) => s.pending.some((p) => p.name === 'Bob'))).pending.find(
        (p) => p.name === 'Bob'
      );
      assert.equal((await ask(admin, 'admin:decide', { voterId: pendingBob.id, approve: false })).ok, true);
      const mine = await bobState.waitFor((s) => s.status === 'rejected');
      assert.deepEqual(mine.options, []);
      const state = await adminState.waitFor((s) => s.rejectedCount === 1);
      assert.equal(state.pending.length, 0);
    });

    await t.test('closing stops further votes and joins and is pushed to voters', async () => {
      assert.equal((await ask(admin, 'admin:close', {})).ok, true);
      const mine = await voterState.waitFor((s) => s.closed === true);
      assert.equal(mine.hasVoted, true);
      await adminState.waitFor((s) => s.closed === true);

      const late = await connectSocket();
      const res = await ask(late, 'voter:join', { pin, name: 'Latecomer' });
      assert.equal(res.ok, false);
    });

    await t.test('voters never receive admin state or the admin token', () => {
      assert.equal(voterLeaks, 0);
      assert.ok(!JSON.stringify(voterState.last()).includes(adminToken));
    });
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

// ---- hardening: client IP, rate limits, flood protection, CSP ----

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      })
      .on('error', reject);
  });
}

test('clientIp takes the Nth entry from the right of X-Forwarded-For', () => {
  const xff = (value) => (value === undefined ? {} : { 'x-forwarded-for': value });
  assert.equal(clientIp(xff('1.1.1.1, 2.2.2.2, 3.3.3.3'), '9.9.9.9', 1), '3.3.3.3');
  assert.equal(clientIp(xff('1.1.1.1, 2.2.2.2, 3.3.3.3'), '9.9.9.9', 2), '2.2.2.2');
  assert.equal(clientIp(xff('spoofed-by-client, 3.3.3.3'), '9.9.9.9', 1), '3.3.3.3');
  assert.equal(clientIp(xff(), '9.9.9.9', 1), '9.9.9.9'); // header missing
  assert.equal(clientIp(xff('1.1.1.1'), '9.9.9.9', 2), '9.9.9.9'); // header shorter than hops
  assert.equal(clientIp(xff('1.1.1.1'), '9.9.9.9', 0), '9.9.9.9'); // no proxy trusted
  assert.equal(clientIp(xff(' , '), '9.9.9.9', 1), '9.9.9.9'); // nothing usable in the header
  assert.equal(clientIp({ 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] }, 'r', 1), '2.2.2.2');
  assert.equal(clientIp({}, '::ffff:10.0.0.5', 1), '10.0.0.5');
  assert.equal(clientIp({}, undefined, 1), 'unknown');
});

test('POST /api/polls is limited per client IP (10 per window, only successes count)', async () => {
  const app = await start(0);
  try {
    const post = (body, headers = {}) =>
      fetch(`${app.url}/api/polls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const valid = { title: 'T', options: ['a', 'b'] };

    for (let i = 0; i < 10; i++) assert.equal((await post(valid)).status, 201, `create #${i + 1}`);
    const blocked = await post(valid);
    assert.equal(blocked.status, 429);
    assert.equal(typeof (await blocked.json()).error, 'string');

    // Another client (the last X-Forwarded-For entry, as appended by the proxy) has its own allowance,
    // and requests that fail validation don't use any of it.
    const other = { 'x-forwarded-for': 'spoofed, 203.0.113.8' };
    for (let i = 0; i < 15; i++) assert.equal((await post({ title: '', options: [] }, other)).status, 400);
    for (let i = 0; i < 10; i++) assert.equal((await post(valid, other)).status, 201);
    assert.equal((await post(valid, other)).status, 429);
  } finally {
    await app.close();
  }
});

test('a socket that floods events is disconnected, others are not', async () => {
  const app = await start(0);
  const sockets = [];
  try {
    const flood = await open(app.url);
    const calm = await open(app.url);
    sockets.push(flood, calm);
    const dropped = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('flooding socket was not disconnected')), 3000);
      flood.once('disconnect', (reason) => {
        clearTimeout(timer);
        resolve(reason);
      });
    });
    for (let i = 0; i < 40; i++) flood.emit('voter:resume', { voterToken: 'nope' }, () => {});
    assert.equal(await dropped, 'io server disconnect');
    assert.equal(flood.connected, false);

    assert.equal(calm.connected, true);
    assert.equal((await ask(calm, 'voter:resume', { voterToken: 'nope' })).ok, false);
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

test('concurrent sockets are capped per IP (1000)', { timeout: 60000 }, async () => {
  const app = await start(0);
  const sockets = [];
  try {
    // Opened in batches: hundreds of simultaneous handshakes can overwhelm the OS accept queue on some machines.
    for (let batch = 0; batch < 40; batch++) {
      sockets.push(...(await Promise.all(Array.from({ length: 25 }, () => open(app.url)))));
    }
    assert.equal(sockets.length, 1000);
    await assert.rejects(open(app.url), /Too many connections/);

    sockets[0].close(); // frees one slot once the server notices
    let reopened = null;
    for (let i = 0; i < 40 && !reopened; i++) {
      try {
        reopened = await open(app.url);
      } catch (err) {
        await sleep(50);
      }
    }
    assert.ok(reopened, 'a slot should free up after a disconnect');
    sockets.push(reopened);
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

test('voter:join is limited per IP (300/min; a failed join costs 2)', { timeout: 30000 }, async () => {
  const app = await start(0);
  const sockets = [];
  try {
    const group = await Promise.all([0, 1, 2, 3, 4, 5].map(() => open(app.url)));
    sockets.push(...group);
    const errors = [];
    // Spread over six sockets so none trips the per-socket flood limit (30 events).
    for (let i = 0; i < 151; i++) {
      const res = await ask(group[i % 6], 'voter:join', { pin: '000000', name: `Person ${i}` });
      errors.push(res.error);
    }
    assert.ok(errors.slice(0, 150).every((e) => /No poll found/.test(e)), 'first 150 failed joins are answered normally');
    assert.match(errors[150], /Too many attempts/);

    // A different client IP is unaffected.
    const other = connect(app.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { 'x-forwarded-for': '198.51.100.9' },
    });
    sockets.push(other);
    await new Promise((resolve, reject) => {
      other.once('connect', resolve);
      other.once('connect_error', reject);
    });
    assert.match((await ask(other, 'voter:join', { pin: '000000', name: 'Someone' })).error, /No poll found/);
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

test('an authenticated admin gets a bigger event budget: 60 approvals in one burst', { timeout: 30000 }, async () => {
  const app = await start(0);
  const sockets = [];
  try {
    const { pin, adminToken } = (await postJson(`${app.url}/api/polls`, { title: 'Crowd', options: ['a', 'b'] })).body;
    const admin = await open(app.url);
    sockets.push(admin);
    const adminState = track(admin, 'admin:state');
    assert.equal((await ask(admin, 'admin:auth', { token: adminToken })).ok, true);

    // 60 voters, joined in batches so the OS accept queue is never swamped.
    for (let batch = 0; batch < 3; batch++) {
      const group = await Promise.all(Array.from({ length: 20 }, () => open(app.url)));
      sockets.push(...group);
      const joined = await Promise.all(group.map((s, i) => ask(s, 'voter:join', { pin, name: `Bot ${batch}-${i}` })));
      for (const r of joined) assert.equal(r.ok, true, r.error);
    }
    const state = await adminState.waitFor((s) => s.pending.length === 60);

    // 60 decide events fired at once, twice the 30-event budget voters get. All must be acknowledged.
    const started = Date.now();
    const results = await Promise.all(state.pending.map((p) => ask(admin, 'admin:decide', { voterId: p.id, approve: true })));
    assert.ok(results.every((r) => r.ok === true), JSON.stringify(results.find((r) => !r.ok)));
    assert.ok(Date.now() - started < 10_000, 'burst finished inside one flood window');
    assert.equal(admin.connected, true);
    await adminState.waitFor((s) => s.approved.length === 60 && s.pending.length === 0);
    assert.equal(admin.connected, true);
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

test('an admin over the event budget is told to slow down, not disconnected', { timeout: 60000 }, async () => {
  const app = await start(0);
  const sockets = [];
  try {
    const { adminToken } = (await postJson(`${app.url}/api/polls`, { title: 'Busy host', options: ['a', 'b'] })).body;
    const admin = await open(app.url);
    sockets.push(admin);
    let disconnects = 0;
    admin.on('disconnect', () => {
      disconnects += 1;
    });
    // admin:auth arrives before the socket is an admin, so it counts against the strict voter budget, not this one.
    assert.equal((await ask(admin, 'admin:auth', { token: adminToken })).ok, true);

    // 1100 commands in one burst. The first 1000 get a normal answer (nobody to approve: "Voter not found");
    // the remaining 100 are refused with the slow-down message.
    const acks = await Promise.all(
      Array.from({ length: 1100 }, () => ask(admin, 'admin:decide', { voterId: 'nobody', approve: true }))
    );
    const handled = acks.filter((a) => a.error === 'Voter not found');
    const slow = acks.filter((a) => a.ok === false && /slow down/.test(a.error));
    assert.equal(handled.length, 1000);
    assert.equal(slow.length, 100);
    assert.equal(admin.connected, true);
    assert.equal(disconnects, 0);

    // Still over budget inside the same window...
    const early = await ask(admin, 'admin:setLive', { live: true });
    assert.equal(early.ok, false);
    assert.match(early.error, /slow down/);

    // ...and fine once the window has rolled over.
    await sleep(10_500);
    assert.deepEqual(await ask(admin, 'admin:setLive', { live: true }), { ok: true });
    assert.equal(admin.connected, true);
    assert.equal(disconnects, 0);
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

test('admin:approveAll approves everyone waiting with a single broadcast', async () => {
  const app = await start(0);
  const sockets = [];
  try {
    const { pin, adminToken } = (await postJson(`${app.url}/api/polls`, { title: 'Room', options: ['a', 'b'] })).body;
    const admin = await open(app.url);
    sockets.push(admin);
    let adminEvents = 0;
    admin.on('admin:state', () => {
      adminEvents += 1;
    });
    const adminState = track(admin, 'admin:state');
    assert.equal((await ask(admin, 'admin:auth', { token: adminToken })).ok, true);

    const voters = [];
    for (let i = 0; i < 5; i++) {
      const s = await open(app.url);
      sockets.push(s);
      const state = track(s, 'voter:state');
      assert.equal((await ask(s, 'voter:join', { pin, name: `Guest ${i}` })).ok, true);
      voters.push({ s, state });
    }
    await adminState.waitFor((s) => s.pending.length === 5);
    for (const v of voters) await v.state.waitFor((s) => s.status === 'pending');
    await sleep(100); // let every join broadcast land before counting

    const before = adminEvents;
    const res = await ask(admin, 'admin:approveAll', {});
    assert.deepEqual(res, { ok: true, count: 5 });
    await adminState.waitFor((s) => s.pending.length === 0 && s.approved.length === 5);
    for (const v of voters) {
      const mine = await v.state.waitFor((s) => s.status === 'approved');
      assert.equal(mine.options.length, 2);
    }
    await sleep(200);
    assert.equal(adminEvents - before, 1, 'one admin:state for the whole batch');

    // Nothing left to approve.
    assert.deepEqual(await ask(admin, 'admin:approveAll', {}), { ok: true, count: 0 });

    // Not an admin: refused.
    const stranger = await open(app.url);
    sockets.push(stranger);
    assert.equal((await ask(stranger, 'admin:approveAll', {})).ok, false);
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

test('a crowd of 150 can all be waiting at once and approve-all lets them in', { timeout: 60000 }, async () => {
  const app = await start(0);
  const sockets = [];
  try {
    const { pin, adminToken } = (await postJson(`${app.url}/api/polls`, { title: 'Big room', options: ['a', 'b'] })).body;
    const admin = await open(app.url);
    sockets.push(admin);
    const adminState = track(admin, 'admin:state');
    assert.equal((await ask(admin, 'admin:auth', { token: adminToken })).ok, true);

    // 150 people join before the admin approves anyone; nobody may be turned away.
    for (let batch = 0; batch < 6; batch++) {
      const group = await Promise.all(Array.from({ length: 25 }, () => open(app.url)));
      sockets.push(...group);
      const joined = await Promise.all(group.map((s, i) => ask(s, 'voter:join', { pin, name: `Guest ${batch}-${i}` })));
      for (const r of joined) assert.equal(r.ok, true, r.error);
    }
    await adminState.waitFor((s) => s.pending.length === 150);

    assert.deepEqual(await ask(admin, 'admin:approveAll', {}), { ok: true, count: 150 });
    await adminState.waitFor((s) => s.approved.length === 150 && s.pending.length === 0);
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

test('a burst of 50 votes is coalesced into far fewer admin:state pushes, with a correct final state', { timeout: 30000 }, async () => {
  const app = await start(0);
  const sockets = [];
  try {
    const { pin, adminToken } = (await postJson(`${app.url}/api/polls`, { title: 'Burst', options: ['a', 'b'] })).body;
    const admin = await open(app.url);
    sockets.push(admin);
    let adminEvents = 0;
    admin.on('admin:state', () => {
      adminEvents += 1;
    });
    const adminState = track(admin, 'admin:state');
    assert.equal((await ask(admin, 'admin:auth', { token: adminToken })).ok, true);
    assert.equal((await ask(admin, 'admin:setLive', { live: true })).ok, true);

    const voters = [];
    for (let batch = 0; batch < 2; batch++) {
      const group = await Promise.all(Array.from({ length: 25 }, () => open(app.url)));
      sockets.push(...group);
      const joined = await Promise.all(group.map((s, i) => ask(s, 'voter:join', { pin, name: `Voter ${batch}-${i}` })));
      for (const r of joined) assert.equal(r.ok, true, r.error);
      for (const s of group) voters.push({ s, state: track(s, 'voter:state') });
    }
    await adminState.waitFor((s) => s.pending.length === 50);
    assert.deepEqual(await ask(admin, 'admin:approveAll', {}), { ok: true, count: 50 });
    await adminState.waitFor((s) => s.approved.length === 50);
    for (const v of voters) await v.state.waitFor((s) => s.status === 'approved');
    await sleep(500); // every earlier push has landed, so the count below starts clean

    const before = adminEvents;
    const acks = await Promise.all(voters.map((v, i) => ask(v.s, 'voter:vote', { choices: [i % 2] })));
    for (const a of acks) assert.equal(a.ok, true, a.error);
    await adminState.waitFor((s) => s.totalVoted === 50);
    await sleep(500); // let any trailing push land before counting
    const pushes = adminEvents - before;

    assert.ok(pushes >= 1, 'the admin is still told');
    assert.ok(pushes < 10, `50 votes should coalesce into a handful of admin:state pushes, saw ${pushes}`);
    assert.equal(adminState.last().totalVoted, 50);
    assert.deepEqual(adminState.last().options.map((o) => o.count), [25, 25]);
    assert.ok(adminState.last().approved.every((v) => v.hasVoted));
    // Live results: every voter's last state carries the full tally, even though their pushes were merged.
    for (const v of voters) {
      const mine = await v.state.waitFor((s) => s.hasVoted === true && s.results && s.results.totalVoted === 50);
      assert.deepEqual(mine.results.options.map((o) => o.count), [25, 25]);
    }
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

test('the larger admin budget only covers admin:* events: other events on an admin socket still flood-disconnect', { timeout: 30000 }, async () => {
  const app = await start(0);
  const sockets = [];
  try {
    const { adminToken } = (await postJson(`${app.url}/api/polls`, { title: 'Scoped', options: ['a', 'b'] })).body;
    const floodAdmin = await open(app.url);
    const busyAdmin = await open(app.url);
    sockets.push(floodAdmin, busyAdmin);
    assert.equal((await ask(floodAdmin, 'admin:auth', { token: adminToken })).ok, true);
    assert.equal((await ask(busyAdmin, 'admin:auth', { token: adminToken })).ok, true);

    let busyDrops = 0;
    busyAdmin.on('disconnect', () => {
      busyDrops += 1;
    });
    const dropped = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('admin socket flooding voter:resume was not disconnected')), 3000);
      floodAdmin.once('disconnect', (reason) => {
        clearTimeout(timer);
        resolve(reason);
      });
    });

    // 40 voter events inside 10 seconds on an authenticated admin socket: past the strict 30-event budget.
    for (let i = 0; i < 40; i++) floodAdmin.emit('voter:resume', { voterToken: 'nope' }, () => {});
    assert.equal(await dropped, 'io server disconnect');
    assert.equal(floodAdmin.connected, false);

    // 500 admin commands on the other admin socket are well inside the admin budget: all answered, no disconnect.
    const acks = await Promise.all(Array.from({ length: 500 }, () => ask(busyAdmin, 'admin:decide', { voterId: 'nobody', approve: true })));
    assert.ok(acks.every((a) => a.error === 'Voter not found'), JSON.stringify(acks.find((a) => a.error !== 'Voter not found')));
    assert.equal(busyAdmin.connected, true);
    assert.equal(busyDrops, 0);
  } finally {
    for (const s of sockets) s.close();
    await app.close();
  }
});

test('CSP connect-src is built from a validated Host header', async () => {
  const app = await start(0);
  try {
    const host = new URL(app.url).host;

    const plain = await rawGet(`${app.url}/healthz`, {});
    assert.ok(plain.headers['content-security-policy'].includes(`connect-src 'self' wss://${host} ws://${host};`));

    const secure = (await rawGet(`${app.url}/healthz`, { 'x-forwarded-proto': 'https' })).headers['content-security-policy'];
    assert.ok(secure.includes(`connect-src 'self' wss://${host};`), secure);
    assert.ok(!secure.includes(`ws://${host}`));

    const evil = (await rawGet(`${app.url}/healthz`, { host: 'evil.com;script-src *' })).headers['content-security-policy'];
    assert.ok(evil.includes("connect-src 'self';"), evil);
    assert.ok(!evil.includes('evil.com'));
  } finally {
    await app.close();
  }
});
