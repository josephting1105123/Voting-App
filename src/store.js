'use strict';

// In-memory poll store. No socket/express imports so it can be unit-tested directly.
// Every mutating function is synchronous and returns { ok: true, ... } or { ok: false, error }.

const crypto = require('crypto');

const LIMITS = Object.freeze({
  TITLE_MAX: 120,
  OPTION_MAX: 100,
  OPTIONS_MIN: 2,
  OPTIONS_MAX: 20,
  NAME_MAX: 40,
  VOTERS_MAX: 500, // pending + approved, per poll. Rejected voters are deleted, so they free their slot.
  PENDING_MAX: 500, // waiting for approval, per poll. Same as VOTERS_MAX, so 500 active is the only limit by default.
  GLOBAL_VOTERS_MAX: 50_000, // across every poll in the store
  POLLS_MAX: 2000,
  POLLS_PER_IP: 30,
  TTL_MS: 24 * 60 * 60 * 1000,
});

// Control (Cc), format (Cf: zero-width space, BOM, bidi marks...), line/paragraph separators, and the Hangul
// filler characters that render as blank. None are valid in titles, options or names.
// Exception: ZWNJ and ZWJ (U+200C/U+200D) are allowed, because emoji sequences and Persian/Indic text need them.
// They are ignored when checking for "empty" and when building the uniqueness key, so they can't be used to fake
// a different name.
const BAD_CHARS = /(?![‌‍])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]/u;
const JOINERS = /[‌‍]/g;
const JOIN_KEY = /^[0-9a-f]{32}$/;

const fail = (error) => ({ ok: false, error });

// Trim, NFC-normalise and validate a single-line string. Length counts code points, not UTF-16 units.
function cleanText(value, label, max) {
  if (typeof value !== 'string') return { error: `${label} is required` };
  const text = value.trim().normalize('NFC');
  if (text.replace(JOINERS, '').trim().length === 0) return { error: `${label} can't be empty` };
  if (BAD_CHARS.test(text)) return { error: `${label} has invalid characters` };
  if ([...text].length > max) return { error: `${label} must be ${max} characters or fewer` };
  return { text };
}

// Uniqueness key for names and options: compatibility-folded (full-width, ligatures...), joiners removed,
// case-folded.
function uniqueKey(text) {
  return text.normalize('NFKC').replace(JOINERS, '').toLowerCase();
}

function createStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const L = Object.freeze({ ...LIMITS, ...(options.limits || {}) });

  const polls = new Map(); // poll id -> poll
  const byPin = new Map(); // pin -> poll
  const byAdminToken = new Map(); // admin token -> poll
  const byVoterToken = new Map(); // voter token -> { poll, voter }
  const pollsByIp = new Map(); // creator ip -> number of live polls
  let totalVoters = 0; // voters currently held in memory, across all polls

  function newId() {
    return crypto.randomBytes(16).toString('hex');
  }

  function allocatePin() {
    for (let i = 0; i < 100; i++) {
      const pin = String(crypto.randomInt(100000, 1000000));
      if (!byPin.has(pin)) return pin;
    }
    return null;
  }

  function removePoll(poll) {
    polls.delete(poll.id);
    byPin.delete(poll.pin);
    byAdminToken.delete(poll.adminToken);
    for (const voter of poll.voters.values()) byVoterToken.delete(voter.token);
    totalVoters -= poll.voters.size;
    if (poll.creatorIp) {
      const left = (pollsByIp.get(poll.creatorIp) || 1) - 1;
      if (left > 0) pollsByIp.set(poll.creatorIp, left);
      else pollsByIp.delete(poll.creatorIp);
    }
  }

  // ---- lookups -------------------------------------------------------------

  function getByAdminToken(token) {
    return typeof token === 'string' ? byAdminToken.get(token) || null : null;
  }

  function getByPin(pin) {
    return typeof pin === 'string' ? byPin.get(pin) || null : null;
  }

  function getVoterByToken(token) {
    if (typeof token !== 'string') return null;
    const found = byVoterToken.get(token);
    return found ? { poll: found.poll, voter: found.voter } : null;
  }

  // ---- mutations -----------------------------------------------------------

  // creatorIp is optional. When given, one IP may hold at most POLLS_PER_IP live polls
  // (failure carries code: 'ip_limit' so the HTTP layer can answer 429).
  function createPoll(input, creatorIp) {
    const body = input !== null && typeof input === 'object' ? input : {};

    const title = cleanText(body.title, 'Title', L.TITLE_MAX);
    if (title.error) return fail(title.error);

    if (!Array.isArray(body.options)) return fail('Options must be a list');
    if (body.options.length < L.OPTIONS_MIN) return fail(`Add at least ${L.OPTIONS_MIN} options`);
    if (body.options.length > L.OPTIONS_MAX) return fail(`Use at most ${L.OPTIONS_MAX} options`);

    const texts = [];
    const seen = new Set();
    for (let i = 0; i < body.options.length; i++) {
      const opt = cleanText(body.options[i], `Option ${i + 1}`, L.OPTION_MAX);
      if (opt.error) return fail(opt.error);
      const key = uniqueKey(opt.text);
      if (seen.has(key)) return fail(`Option "${opt.text}" appears more than once`);
      seen.add(key);
      texts.push(opt.text);
    }

    for (const flag of ['multi', 'anonymous']) {
      if (body[flag] !== undefined && typeof body[flag] !== 'boolean') {
        return fail(`${flag} must be true or false`);
      }
    }

    const ip = typeof creatorIp === 'string' && creatorIp ? creatorIp : null;
    const overIp = () => ip !== null && (pollsByIp.get(ip) || 0) >= L.POLLS_PER_IP;
    if (polls.size >= L.POLLS_MAX || overIp()) sweep();
    if (polls.size >= L.POLLS_MAX) return fail('Too many active polls right now. Try again later.');
    if (overIp()) {
      return { ok: false, error: 'You already have the maximum number of open polls. Try again later.', code: 'ip_limit' };
    }

    const pin = allocatePin();
    if (!pin) return fail('Could not allocate a PIN. Try again.');

    let id = newId();
    while (polls.has(id)) id = newId();

    const poll = {
      id,
      pin,
      adminToken: crypto.randomBytes(24).toString('hex'),
      title: title.text,
      options: texts.map((text, i) => ({ id: i, text, count: 0 })),
      multi: body.multi === true,
      anonymous: body.anonymous === true,
      live: false,
      closed: false,
      createdAt: now(),
      creatorIp: ip,
      voters: new Map(),
      // Counters and indexes kept in step by join/decide/vote so views never have to scan voters.
      activeCount: 0, // pending + approved
      pendingCount: 0,
      totalVoted: 0,
      rejectedCount: 0,
      nameIndex: new Map(), // uniqueKey(name) -> voter, pending + approved only
    };

    polls.set(poll.id, poll);
    byPin.set(poll.pin, poll);
    byAdminToken.set(poll.adminToken, poll);
    if (ip) pollsByIp.set(ip, (pollsByIp.get(ip) || 0) + 1);
    return { ok: true, poll, pin: poll.pin, adminToken: poll.adminToken };
  }

  function joinResult(poll, voter) {
    return { ok: true, poll, voter, voterId: voter.id, voterToken: voter.token, pollId: poll.id };
  }

  // joinKey (optional, 32 hex chars from the client) makes a retried join idempotent: the same key and
  // name while still pending or approved returns the existing voter instead of "name taken".
  function joinPoll(pin, name, joinKey) {
    // Name first, so a bad name gives the same answer whether or not the PIN exists.
    const clean = cleanText(name, 'Name', L.NAME_MAX);
    if (clean.error) return fail(clean.error);

    let key = null;
    if (joinKey !== undefined && joinKey !== null) {
      if (typeof joinKey !== 'string' || !JOIN_KEY.test(joinKey)) return fail('Invalid join key');
      key = joinKey;
    }

    const pinText = typeof pin === 'string' || typeof pin === 'number' ? String(pin).trim() : '';
    if (!/^\d{6}$/.test(pinText)) return fail('Enter the 6-digit PIN');
    const poll = byPin.get(pinText);
    if (!poll) return fail('No poll found with that PIN');
    if (poll.closed) return fail('This poll is closed');

    const existing = poll.nameIndex.get(uniqueKey(clean.text));
    if (existing) {
      // Same key = same browser retrying. That includes after approval: the retry can cross the approval.
      if (key !== null && existing.joinKey === key && (existing.status === 'pending' || existing.status === 'approved')) {
        return joinResult(poll, existing);
      }
      return fail('That name is already taken in this poll');
    }

    if (totalVoters >= L.GLOBAL_VOTERS_MAX) return fail('The server is busy right now. Try again shortly.');
    if (poll.activeCount >= L.VOTERS_MAX) return fail('This poll is full');
    if (poll.pendingCount >= L.PENDING_MAX) return fail('Too many people waiting — try again shortly');

    let id = newId();
    while (poll.voters.has(id)) id = newId();
    const voter = {
      id,
      name: clean.text,
      status: 'pending',
      token: crypto.randomBytes(24).toString('hex'),
      hasVoted: false,
      choices: null,
      joinKey: key,
    };
    poll.voters.set(id, voter);
    poll.nameIndex.set(uniqueKey(voter.name), voter);
    poll.activeCount += 1;
    poll.pendingCount += 1;
    totalVoters += 1;
    byVoterToken.set(voter.token, { poll, voter });
    return joinResult(poll, voter);
  }

  // Approving keeps the voter. Rejecting deletes them from the poll straight away (freeing their slot and
  // their name) and returns the voter object so the caller can still tell them "declined".
  function decide(adminToken, voterId, approve) {
    const poll = getByAdminToken(adminToken);
    if (!poll) return fail('Poll not found');
    if (typeof approve !== 'boolean') return fail('approve must be true or false');
    const voter = typeof voterId === 'string' ? poll.voters.get(voterId) : undefined;
    if (!voter) return fail('Voter not found');
    if (voter.status !== 'pending') return fail('That voter has already been handled');

    poll.pendingCount -= 1;
    if (approve) {
      voter.status = 'approved';
    } else {
      voter.status = 'rejected';
      poll.activeCount -= 1;
      poll.rejectedCount += 1;
      poll.nameIndex.delete(uniqueKey(voter.name));
      poll.voters.delete(voter.id);
      byVoterToken.delete(voter.token);
      totalVoters -= 1;
    }
    return { ok: true, poll, voter };
  }

  // Approves everyone currently pending. They already count toward the active cap, so this only flips status.
  // Returns the newly approved voters so the caller can tell each of them.
  function approveAll(adminToken) {
    const poll = getByAdminToken(adminToken);
    if (!poll) return fail('Poll not found');
    const voters = [];
    for (const voter of poll.voters.values()) {
      if (voter.status === 'pending') {
        voter.status = 'approved';
        voters.push(voter);
      }
    }
    poll.pendingCount -= voters.length;
    return { ok: true, poll, count: voters.length, voters };
  }

  function setLive(adminToken, live) {
    const poll = getByAdminToken(adminToken);
    if (!poll) return fail('Poll not found');
    if (typeof live !== 'boolean') return fail('live must be true or false');
    poll.live = live;
    return { ok: true, poll };
  }

  function closePoll(adminToken) {
    const poll = getByAdminToken(adminToken);
    if (!poll) return fail('Poll not found');
    poll.closed = true;
    return { ok: true, poll };
  }

  function vote(voterToken, choices) {
    const found = getVoterByToken(voterToken);
    if (!found) return fail('Voter not found');
    const { poll, voter } = found;

    if (poll.closed) return fail('This poll is closed');
    if (voter.status === 'pending') return fail('The host has not approved you yet');
    if (voter.status !== 'approved') return fail('Your request was declined');
    if (voter.hasVoted) return fail('You have already voted');

    if (!Array.isArray(choices) || choices.length === 0) return fail('Choose an option');
    if (choices.length > poll.options.length) return fail('Too many choices');
    const picked = new Set();
    for (const c of choices) {
      // Option ids are their index in poll.options.
      if (!Number.isInteger(c) || c < 0 || c >= poll.options.length) return fail('Invalid choice');
      if (picked.has(c)) return fail('Duplicate choice');
      picked.add(c);
    }
    if (!poll.multi && picked.size !== 1) return fail('Choose exactly one option');

    // All checks passed: commit.
    for (const c of picked) poll.options[c].count += 1;
    voter.hasVoted = true;
    poll.totalVoted += 1;
    // Anonymous polls never store who picked what; only tallies and hasVoted exist.
    voter.choices = poll.anonymous ? null : [...picked].sort((a, b) => a - b);
    return { ok: true, poll, voter };
  }

  // ---- views ---------------------------------------------------------------

  function adminView(poll) {
    const pending = [];
    const approved = [];
    for (const v of poll.voters.values()) {
      if (v.status === 'pending') {
        pending.push({ id: v.id, name: v.name });
      } else if (v.status === 'approved') {
        const entry = { id: v.id, name: v.name, hasVoted: v.hasVoted };
        if (!poll.anonymous) entry.choices = v.choices ? v.choices.slice() : [];
        approved.push(entry);
      }
    }
    return {
      pin: poll.pin,
      title: poll.title,
      multi: poll.multi,
      anonymous: poll.anonymous,
      live: poll.live,
      closed: poll.closed,
      options: poll.options.map((o) => ({ id: o.id, text: o.text, count: o.count })),
      totalVoted: poll.totalVoted,
      pending,
      approved,
      rejectedCount: poll.rejectedCount,
    };
  }

  // O(options): never scans the other voters.
  function voterView(poll, voter) {
    return {
      status: voter.status,
      name: voter.name,
      title: poll.title,
      multi: poll.multi,
      closed: poll.closed,
      // Options are only revealed once the host has let this voter in.
      options: voter.status === 'approved' ? poll.options.map((o) => ({ id: o.id, text: o.text })) : [],
      hasVoted: voter.hasVoted,
      myChoices: !poll.anonymous && voter.choices ? voter.choices.slice() : null,
      results:
        voter.hasVoted && poll.live
          ? { options: poll.options.map((o) => ({ id: o.id, count: o.count })), totalVoted: poll.totalVoted }
          : null,
    };
  }

  // ---- housekeeping --------------------------------------------------------

  function sweep(at) {
    const t = typeof at === 'number' ? at : now();
    let removed = 0;
    for (const poll of [...polls.values()]) {
      if (t - poll.createdAt >= L.TTL_MS) {
        removePoll(poll);
        removed += 1;
      }
    }
    return removed;
  }

  function size() {
    return polls.size;
  }

  function stats() {
    return { polls: polls.size, voters: totalVoters };
  }

  return {
    createPoll,
    getByAdminToken,
    getByPin,
    joinPoll,
    getVoterByToken,
    decide,
    approveAll,
    setLive,
    closePoll,
    vote,
    adminView,
    voterView,
    sweep,
    size,
    stats,
  };
}

module.exports = { createStore, LIMITS };
