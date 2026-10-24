'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore, LIMITS } = require('../src/store');

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const clock = { t: 1_700_000_000_000 };
  const store = createStore({ now: () => clock.t });
  return { store, clock };
}

function newPoll(store, overrides = {}) {
  const r = store.createPoll({
    title: 'Lunch?',
    options: ['Pizza', 'Sushi', 'Tacos'],
    multi: false,
    anonymous: false,
    ...overrides,
  });
  assert.equal(r.ok, true, r.error);
  return r;
}

// Join and (by default) approve. Returns the join result.
function addVoter(store, poll, name, approve = true) {
  const j = store.joinPoll(poll.pin, name);
  assert.equal(j.ok, true, j.error);
  if (approve) assert.equal(store.decide(poll.adminToken, j.voterId, true).ok, true);
  return j;
}

test('createPoll rejects an empty or blank title', () => {
  const { store } = setup();
  for (const title of ['', '   ', undefined, 42]) {
    const r = store.createPoll({ title, options: ['a', 'b'] });
    assert.equal(r.ok, false);
    assert.match(r.error, /title/i);
  }
});

test('createPoll rejects a title over 120 characters and trims valid ones', () => {
  const { store } = setup();
  assert.equal(store.createPoll({ title: 'x'.repeat(121), options: ['a', 'b'] }).ok, false);
  const ok = store.createPoll({ title: '  ' + 'x'.repeat(120) + '  ', options: ['a', 'b'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.poll.title.length, 120);
});

test('createPoll rejects fewer than 2 or more than 20 options', () => {
  const { store } = setup();
  assert.equal(store.createPoll({ title: 'T', options: ['only one'] }).ok, false);
  assert.equal(store.createPoll({ title: 'T', options: [] }).ok, false);
  assert.equal(store.createPoll({ title: 'T', options: 'a,b' }).ok, false);
  const many = Array.from({ length: 21 }, (_, i) => `opt ${i}`);
  assert.equal(store.createPoll({ title: 'T', options: many }).ok, false);
  assert.equal(store.createPoll({ title: 'T', options: many.slice(0, 20) }).ok, true);
});

test('createPoll rejects duplicate, empty, over-long and non-string options', () => {
  const { store } = setup();
  const dup = store.createPoll({ title: 'T', options: ['Pizza', ' pizza '] });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /more than once/);
  assert.equal(store.createPoll({ title: 'T', options: ['a', '   '] }).ok, false);
  assert.equal(store.createPoll({ title: 'T', options: ['a', 'b'.repeat(101)] }).ok, false);
  assert.equal(store.createPoll({ title: 'T', options: ['a', 5] }).ok, false);
});

test('createPoll rejects non-boolean flags', () => {
  const { store } = setup();
  assert.equal(store.createPoll({ title: 'T', options: ['a', 'b'], multi: 'yes' }).ok, false);
  assert.equal(store.createPoll({ title: 'T', options: ['a', 'b'], anonymous: 1 }).ok, false);
});

test('PINs are 6 digits (100000-999999) and unique; admin token is 48 hex chars', () => {
  const { store } = setup();
  const pins = new Set();
  for (let i = 0; i < 300; i++) {
    const r = newPoll(store);
    assert.match(r.pin, /^\d{6}$/);
    assert.ok(Number(r.pin) >= 100000 && Number(r.pin) <= 999999);
    assert.match(r.adminToken, /^[0-9a-f]{48}$/);
    pins.add(r.pin);
  }
  assert.equal(pins.size, 300);
});

test('creation is refused at the poll cap and works again after expiry', () => {
  const { store, clock } = setup();
  for (let i = 0; i < LIMITS.POLLS_MAX; i++) newPoll(store);
  const full = store.createPoll({ title: 'T', options: ['a', 'b'] });
  assert.equal(full.ok, false);
  clock.t += DAY;
  assert.equal(store.createPoll({ title: 'T', options: ['a', 'b'] }).ok, true);
  assert.equal(store.size(), 1);
});

test('joining creates a pending voter', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const j = store.joinPoll(poll.pin, '  Alice ');
  assert.equal(j.ok, true);
  assert.equal(j.pollId, poll.poll.id);
  const found = store.getVoterByToken(j.voterToken);
  assert.equal(found.voter.status, 'pending');
  assert.equal(found.voter.name, 'Alice');
  assert.equal(found.voter.hasVoted, false);
  assert.equal(found.voter.choices, null);
  assert.deepEqual(store.adminView(poll.poll).pending, [{ id: j.voterId, name: 'Alice' }]);
});

test('join validates the PIN and name', () => {
  const { store } = setup();
  const poll = newPoll(store);
  assert.equal(store.joinPoll('12345', 'A').ok, false);
  assert.equal(store.joinPoll('000000', 'A').ok, false);
  assert.equal(store.joinPoll(poll.pin, '').ok, false);
  assert.equal(store.joinPoll(poll.pin, '   ').ok, false);
  assert.equal(store.joinPoll(poll.pin, 'x'.repeat(41)).ok, false);
  assert.equal(store.joinPoll(poll.pin, 'x'.repeat(40)).ok, true);
});

test('duplicate names are rejected case-insensitively (pending and approved)', () => {
  const { store } = setup();
  const poll = newPoll(store);
  addVoter(store, poll, 'Alice', false); // pending
  addVoter(store, poll, 'Bob', true); // approved
  assert.equal(store.joinPoll(poll.pin, 'ALICE').ok, false);
  assert.equal(store.joinPoll(poll.pin, ' bob ').ok, false);
  assert.equal(store.joinPoll(poll.pin, 'Carol').ok, true);
});

test('a rejected name can rejoin; the rejected record is deleted but still returned by decide', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const first = addVoter(store, poll, 'Alice', false);
  const rejected = store.decide(poll.adminToken, first.voterId, false);
  assert.equal(rejected.ok, true);
  assert.equal(rejected.voter.status, 'rejected');
  // The caller can still build the "declined" view from the returned record...
  const view = store.voterView(poll.poll, rejected.voter);
  assert.equal(view.status, 'rejected');
  assert.deepEqual(view.options, []);
  // ...but nothing remains in the store.
  assert.equal(store.getVoterByToken(first.voterToken), null);
  assert.equal(poll.poll.voters.has(first.voterId), false);

  const again = store.joinPoll(poll.pin, 'alice');
  assert.equal(again.ok, true);
  assert.notEqual(again.voterId, first.voterId);
  assert.equal(store.adminView(poll.poll).rejectedCount, 1);
});

test('the per-poll voter cap (pending + approved) is enforced', () => {
  const { store } = setup();
  const poll = newPoll(store);
  for (let i = 0; i < LIMITS.VOTERS_MAX; i++) addVoter(store, poll, `voter ${i}`);
  assert.equal(store.stats().voters, LIMITS.VOTERS_MAX);
  const over = store.joinPoll(poll.pin, 'one too many');
  assert.equal(over.ok, false);
  assert.match(over.error, /full/i);
});

test('decide only works with the admin token, on pending voters, with a boolean', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const j = addVoter(store, poll, 'Alice', false);
  assert.equal(store.decide('wrong', j.voterId, true).ok, false);
  assert.equal(store.decide(poll.adminToken, 'nope', true).ok, false);
  assert.equal(store.decide(poll.adminToken, j.voterId, 'yes').ok, false);
  assert.equal(store.decide(poll.adminToken, j.voterId, true).ok, true);
  assert.equal(store.decide(poll.adminToken, j.voterId, false).ok, false); // already handled
});

test('voting is rejected while pending or rejected', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const pending = addVoter(store, poll, 'Alice', false);
  const r = store.vote(pending.voterToken, [0]);
  assert.equal(r.ok, false);
  const rejected = addVoter(store, poll, 'Bob', false);
  store.decide(poll.adminToken, rejected.voterId, false);
  assert.equal(store.vote(rejected.voterToken, [0]).ok, false);
  assert.equal(store.getVoterByToken(pending.voterToken).voter.hasVoted, false);
  assert.equal(store.adminView(poll.poll).totalVoted, 0);
});

test('single choice: exactly one valid option id', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const v = addVoter(store, poll, 'Alice');
  assert.equal(store.vote(v.voterToken, [0, 1]).ok, false);
  assert.equal(store.vote(v.voterToken, []).ok, false);
  assert.equal(store.vote(v.voterToken, [99]).ok, false);
  assert.equal(store.vote(v.voterToken, [-1]).ok, false);
  assert.equal(store.vote(v.voterToken, ['0']).ok, false);
  assert.equal(store.vote(v.voterToken, 0).ok, false);
  // Nothing was recorded by any failed attempt.
  assert.deepEqual(
    store.adminView(poll.poll).options.map((o) => o.count),
    [0, 0, 0]
  );
  assert.equal(store.vote(v.voterToken, [2]).ok, true);
  assert.deepEqual(
    store.adminView(poll.poll).options.map((o) => o.count),
    [0, 0, 1]
  );
});

test('multi choice: accepts several, rejects none and duplicates', () => {
  const { store } = setup();
  const poll = newPoll(store, { multi: true });
  const v = addVoter(store, poll, 'Alice');
  assert.equal(store.vote(v.voterToken, []).ok, false);
  assert.equal(store.vote(v.voterToken, [1, 1]).ok, false);
  assert.equal(store.vote(v.voterToken, [0, 2]).ok, true);
  assert.deepEqual(
    store.adminView(poll.poll).options.map((o) => o.count),
    [1, 0, 1]
  );
});

test('a second vote is rejected and does not change tallies', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const v = addVoter(store, poll, 'Alice');
  assert.equal(store.vote(v.voterToken, [0]).ok, true);
  const again = store.vote(v.voterToken, [1]);
  assert.equal(again.ok, false);
  assert.deepEqual(
    store.adminView(poll.poll).options.map((o) => o.count),
    [1, 0, 0]
  );
});

test('voting and joining are rejected after the poll is closed', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const v = addVoter(store, poll, 'Alice');
  assert.equal(store.closePoll('wrong').ok, false);
  assert.equal(store.closePoll(poll.adminToken).ok, true);
  assert.equal(store.vote(v.voterToken, [0]).ok, false);
  assert.equal(store.joinPoll(poll.pin, 'Late').ok, false);
  assert.equal(store.adminView(poll.poll).closed, true);
});

test('anonymous poll: no per-voter choices are stored or exposed', () => {
  const { store } = setup();
  const poll = newPoll(store, { anonymous: true });
  const v = addVoter(store, poll, 'Alice');
  assert.equal(store.vote(v.voterToken, [1]).ok, true);

  const view = store.adminView(poll.poll);
  assert.equal(view.approved.length, 1);
  assert.equal(view.approved[0].hasVoted, true);
  assert.equal('choices' in view.approved[0], false);
  assert.equal(view.options[1].count, 1);
  assert.equal(view.totalVoted, 1);

  const stored = store.getVoterByToken(v.voterToken).voter;
  assert.equal(stored.choices, null);
  assert.equal(stored.hasVoted, true);
  assert.equal(store.voterView(poll.poll, stored).myChoices, null);
});

test('non-anonymous poll: admin sees each voter\'s choices, voter sees their own', () => {
  const { store } = setup();
  const poll = newPoll(store, { multi: true });
  const alice = addVoter(store, poll, 'Alice');
  addVoter(store, poll, 'Bob');
  assert.equal(store.vote(alice.voterToken, [2, 0]).ok, true);

  const view = store.adminView(poll.poll);
  const a = view.approved.find((x) => x.name === 'Alice');
  const b = view.approved.find((x) => x.name === 'Bob');
  assert.ok('choices' in a);
  assert.deepEqual(a.choices, [0, 2]);
  assert.deepEqual(b.choices, []);
  assert.deepEqual(store.voterView(poll.poll, store.getVoterByToken(alice.voterToken).voter).myChoices, [0, 2]);
});

test('voterView.results: null with live off, null before voting, present after voting with live on', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const alice = addVoter(store, poll, 'Alice');
  addVoter(store, poll, 'Bob');
  const aliceRec = () => store.getVoterByToken(alice.voterToken).voter;

  // Live on, but Alice hasn't voted yet.
  assert.equal(store.setLive(poll.adminToken, true).ok, true);
  assert.equal(store.voterView(poll.poll, aliceRec()).results, null);

  // Live off, Alice votes.
  assert.equal(store.setLive(poll.adminToken, false).ok, true);
  assert.equal(store.vote(alice.voterToken, [1]).ok, true);
  assert.equal(store.voterView(poll.poll, aliceRec()).results, null);

  // Live on again.
  store.setLive(poll.adminToken, true);
  const res = store.voterView(poll.poll, aliceRec()).results;
  assert.deepEqual(res, {
    options: [
      { id: 0, count: 0 },
      { id: 1, count: 1 },
      { id: 2, count: 0 },
    ],
    totalVoted: 1,
  });

  // Bob hasn't voted: still nothing, even with live on.
  const bobRec = store.getVoterByToken(addVoter(store, poll, 'Carol').voterToken).voter;
  assert.equal(store.voterView(poll.poll, bobRec).results, null);

  assert.equal(store.setLive(poll.adminToken, 'yes').ok, false);
  assert.equal(store.setLive('wrong', true).ok, false);
});

test('voterView never leaks the admin token or other voters', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const alice = addVoter(store, poll, 'Alice');
  const bob = addVoter(store, poll, 'Zebediah');
  store.vote(bob.voterToken, [0]);
  store.setLive(poll.adminToken, true);
  store.vote(alice.voterToken, [1]);

  const aliceView = store.voterView(poll.poll, store.getVoterByToken(alice.voterToken).voter);
  const json = JSON.stringify(aliceView);
  assert.ok(!json.includes(poll.adminToken));
  assert.ok(!json.includes('Zebediah'));
  assert.ok(!json.includes(bob.voterId));
  assert.ok(!json.includes(bob.voterToken));
  assert.ok(!json.includes(alice.voterToken));
  assert.ok(!json.includes(poll.pin));
  assert.deepEqual(Object.keys(aliceView).sort(), [
    'closed',
    'hasVoted',
    'maxChoices',
    'multi',
    'myChoices',
    'name',
    'options',
    'paused',
    'results',
    'revision',
    'status',
    'title',
  ]);
});

test('pending voters are not shown the options', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const j = addVoter(store, poll, 'Alice', false);
  const view = store.voterView(poll.poll, store.getVoterByToken(j.voterToken).voter);
  assert.equal(view.status, 'pending');
  assert.deepEqual(view.options, []);
});

test('sweep removes polls older than 24h using the injected clock', () => {
  const { store, clock } = setup();
  const old = newPoll(store);
  const voter = addVoter(store, old, 'Alice');
  clock.t += 12 * 60 * 60 * 1000;
  const fresh = newPoll(store);
  assert.equal(store.size(), 2);

  clock.t += DAY - 12 * 60 * 60 * 1000 - 1; // old poll is 24h minus 1ms old
  assert.equal(store.sweep(), 0);
  assert.equal(store.size(), 2);

  clock.t += 1; // exactly 24h
  assert.equal(store.sweep(), 1);
  assert.equal(store.size(), 1);
  assert.equal(store.getByPin(old.pin), null);
  assert.equal(store.getByAdminToken(old.adminToken), null);
  assert.equal(store.getVoterByToken(voter.voterToken), null);
  assert.equal(store.joinPoll(old.pin, 'Bob').ok, false);
  assert.notEqual(store.getByPin(fresh.pin), null);

  assert.equal(store.sweep(clock.t + DAY), 1); // explicit timestamp argument
  assert.equal(store.size(), 0);
});

// ---- hardening: names, caps, idempotent join, counters ----

const VALID_POLL = { title: 'T', options: ['a', 'b'] };

test('the name is validated before the PIN is looked up', () => {
  const { store } = setup();
  const poll = newPoll(store);
  assert.match(store.joinPoll('000000', '').error, /name/i);
  assert.match(store.joinPoll('nope', 'x'.repeat(41)).error, /name/i);
  assert.match(store.joinPoll('000000', 'Al​ice').error, /name/i);
  // With a good name the PIN is what gets reported.
  assert.match(store.joinPoll('000000', 'Alice').error, /poll found/i);
  assert.match(store.joinPoll('12', 'Alice').error, /PIN/);
  // A bad name gets the same answer for a real PIN and a made-up one.
  assert.equal(store.joinPoll(poll.pin, '').error, store.joinPoll('000000', '').error);
});

test('rejected voters free their slot: 500 joins + rejects, then new joins succeed', () => {
  const { store } = setup();
  const poll = newPoll(store);
  for (let i = 0; i < LIMITS.VOTERS_MAX; i++) {
    const j = store.joinPoll(poll.pin, `person ${i}`);
    assert.equal(j.ok, true, j.error);
    assert.equal(store.decide(poll.adminToken, j.voterId, false).ok, true);
  }
  assert.equal(store.stats().voters, 0);
  assert.equal(poll.poll.voters.size, 0);
  assert.equal(store.adminView(poll.poll).rejectedCount, LIMITS.VOTERS_MAX);
  assert.equal(store.joinPoll(poll.pin, 'person 0').ok, true); // a rejected name is reusable
  assert.equal(store.joinPoll(poll.pin, 'fresh').ok, true);
});

test('by default pending is not capped below the 500 active limit', () => {
  const { store } = setup();
  const poll = newPoll(store);
  assert.equal(LIMITS.PENDING_MAX, LIMITS.VOTERS_MAX);
  for (let i = 0; i < LIMITS.VOTERS_MAX; i++) {
    const j = store.joinPoll(poll.pin, `waiting ${i}`);
    assert.equal(j.ok, true, `join #${i + 1}: ${j.error}`);
  }
  assert.equal(store.adminView(poll.poll).pending.length, LIMITS.VOTERS_MAX);
  // The 501st is turned away because the poll is full, not because too many are waiting.
  const over = store.joinPoll(poll.pin, 'one more');
  assert.equal(over.ok, false);
  assert.match(over.error, /full/i);
  // Approving them all doesn't make room: pending and approved share the 500.
  assert.equal(store.approveAll(poll.adminToken).count, LIMITS.VOTERS_MAX);
  assert.match(store.joinPoll(poll.pin, 'one more').error, /full/i);
});

test('a lower pending cap can be configured; approve and reject free a pending slot', () => {
  const store = createStore({ limits: { PENDING_MAX: 3 } });
  const poll = newPoll(store);
  const joined = [];
  for (let i = 0; i < 3; i++) {
    const j = store.joinPoll(poll.pin, `waiting ${i}`);
    assert.equal(j.ok, true, j.error);
    joined.push(j);
  }
  const blocked = store.joinPoll(poll.pin, 'one more');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /waiting/i);

  // Approving frees a pending slot (but still counts as active)...
  store.decide(poll.adminToken, joined[0].voterId, true);
  assert.equal(store.joinPoll(poll.pin, 'one more').ok, true);
  assert.equal(store.joinPoll(poll.pin, 'and another').ok, false);
  // ...and so does rejecting.
  store.decide(poll.adminToken, joined[1].voterId, false);
  assert.equal(store.joinPoll(poll.pin, 'and another').ok, true);
});

test('joinKey makes a retried join idempotent while the voter is pending or approved', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const key = 'a'.repeat(32);
  const first = store.joinPoll(poll.pin, 'Alice', key);
  assert.equal(first.ok, true);

  const retry = store.joinPoll(poll.pin, ' alice ', key);
  assert.equal(retry.ok, true);
  assert.equal(retry.voterId, first.voterId);
  assert.equal(retry.voterToken, first.voterToken);
  assert.equal(store.adminView(poll.poll).pending.length, 1);
  assert.equal(store.stats().voters, 1);

  // Someone else with the same name is still refused.
  assert.equal(store.joinPoll(poll.pin, 'Alice', 'b'.repeat(32)).ok, false);
  assert.equal(store.joinPoll(poll.pin, 'Alice').ok, false);
  // The key doesn't unlock a different name.
  const other = store.joinPoll(poll.pin, 'Bob', key);
  assert.equal(other.ok, true);
  assert.notEqual(other.voterId, first.voterId);
  // Malformed keys are errors, not silently ignored.
  assert.equal(store.joinPoll(poll.pin, 'Carol', 'xyz').ok, false);
  assert.equal(store.joinPoll(poll.pin, 'Carol', 12345).ok, false);
  assert.equal(store.joinPoll(poll.pin, 'Carol', 'A'.repeat(32)).ok, false);

  // After approval the same key still returns the same voter: a retry can cross the approval.
  store.decide(poll.adminToken, first.voterId, true);
  const afterApproval = store.joinPoll(poll.pin, 'Alice', key);
  assert.equal(afterApproval.ok, true);
  assert.equal(afterApproval.voterId, first.voterId);
  assert.equal(afterApproval.voterToken, first.voterToken);
  assert.equal(afterApproval.voter.status, 'approved');
  assert.equal(store.adminView(poll.poll).approved.length, 1);
  assert.equal(store.stats().voters, 2); // Alice and Bob; the retries added nobody
  // ...but a different key or no key is still refused for an approved name.
  assert.equal(store.joinPoll(poll.pin, 'Alice', 'b'.repeat(32)).ok, false);
  assert.equal(store.joinPoll(poll.pin, 'Alice').ok, false);
});

test('an approved voter who already voted retrying with the same joinKey gets the same token and keeps their vote', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const key = 'c'.repeat(32);
  const joined = store.joinPoll(poll.pin, 'Dana', key);
  store.decide(poll.adminToken, joined.voterId, true);
  assert.equal(store.vote(joined.voterToken, [0]).ok, true);

  const retry = store.joinPoll(poll.pin, 'Dana', key);
  assert.equal(retry.ok, true);
  assert.equal(retry.voterToken, joined.voterToken);
  assert.equal(retry.voter.hasVoted, true);
  assert.equal(store.adminView(poll.poll).totalVoted, 1);
});

test('invisible and format characters are rejected in names, titles and options', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const bad = [
    'Al​ice', // zero-width space
    'Al﻿ice', // BOM (a leading one is just trimmed away, like any whitespace)
    'Al‮ice', // right-to-left override
    'Ali ce', // line separator
    'ㅤ', // Hangul filler (renders blank)
    'Aliᅟce',
    'ﾠx',
    'a\u0007b', // control character
  ];
  for (const text of bad) {
    assert.equal(store.joinPoll(poll.pin, text).ok, false, JSON.stringify(text));
    assert.equal(store.createPoll({ title: text, options: ['a', 'b'] }).ok, false, JSON.stringify(text));
    assert.equal(store.createPoll({ title: 'T', options: ['a', text] }).ok, false, JSON.stringify(text));
  }
});

test('names and options that only differ by compatibility form are duplicates (NFKC)', () => {
  const { store } = setup();
  const poll = newPoll(store);
  addVoter(store, poll, 'Alice', false);
  addVoter(store, poll, 'FISH', false);
  assert.match(store.joinPoll(poll.pin, 'Ａlice').error, /taken/); // full-width A
  assert.match(store.joinPoll(poll.pin, 'ＡＬＩＣＥ').error, /taken/); // full-width ALICE
  assert.match(store.joinPoll(poll.pin, 'ﬁsh').error, /taken/); // fi ligature + sh
  assert.equal(store.joinPoll(poll.pin, 'Alicia').ok, true);

  assert.match(store.createPoll({ title: 'T', options: ['Pizza', 'Ｐizza'] }).error, /more than once/);
  assert.match(store.createPoll({ title: 'T', options: ['fish', 'ﬁsh'] }).error, /more than once/);
  assert.equal(store.createPoll({ title: 'T', options: ['Pizza', 'Pasta'] }).ok, true);
});

test('ZWJ and ZWNJ are allowed in text but ignored for emptiness and uniqueness', () => {
  const { store } = setup();
  const poll = newPoll(store);

  // Emoji sequences and Persian text need the joiners.
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  const persian = 'می‌خواهم';
  const j1 = store.joinPoll(poll.pin, family);
  assert.equal(j1.ok, true, j1.error);
  assert.equal(j1.voter.name, family);
  assert.equal(store.joinPoll(poll.pin, persian).ok, true);
  assert.equal(store.createPoll({ title: `Who is ${family}?`, options: [family, persian] }).ok, true);

  // A joiner inside a name doesn't make it a different name.
  assert.equal(store.joinPoll(poll.pin, 'Alice').ok, true);
  assert.match(store.joinPoll(poll.pin, 'Ali‍ce').error, /taken/);
  assert.match(store.joinPoll(poll.pin, 'A‌l‍i‌ce').error, /taken/);
  assert.match(store.joinPoll(poll.pin, '‍ALICE‌').error, /taken/);
  assert.match(store.createPoll({ title: 'T', options: ['Pizza', 'Piz‍za'] }).error, /more than once/);

  // Only joiners and whitespace is still empty.
  for (const text of ['‍', '‌', ' ‍ ‌ ', '‍‌‍']) {
    assert.match(store.joinPoll(poll.pin, text).error, /empty/, JSON.stringify(text));
    assert.match(store.createPoll({ title: text, options: ['a', 'b'] }).error, /empty/);
    assert.match(store.createPoll({ title: 'T', options: ['a', text] }).error, /empty/);
  }
  // The other invisible characters are still refused.
  assert.equal(store.joinPoll(poll.pin, 'Al​ice').ok, false);
  assert.equal(store.joinPoll(poll.pin, '​‍').ok, false);
});

test('approveAll approves every pending voter and nobody else', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const early = addVoter(store, poll, 'Early'); // already approved
  const gone = addVoter(store, poll, 'Gone', false);
  store.decide(poll.adminToken, gone.voterId, false); // already rejected (deleted)
  const waiting = ['Ann', 'Ben', 'Cy'].map((n) => addVoter(store, poll, n, false));
  assert.equal(store.adminView(poll.poll).pending.length, 3);

  assert.equal(store.approveAll('wrong').ok, false);
  const res = store.approveAll(poll.adminToken);
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  assert.deepEqual(res.voters.map((v) => v.name).sort(), ['Ann', 'Ben', 'Cy']);
  assert.ok(res.voters.every((v) => v.status === 'approved'));

  const view = store.adminView(poll.poll);
  assert.deepEqual(view.pending, []);
  assert.equal(view.approved.length, 4);
  assert.equal(view.rejectedCount, 1);
  for (const w of waiting) assert.equal(store.getVoterByToken(w.voterToken).voter.status, 'approved');
  // They can vote straight away.
  assert.equal(store.vote(waiting[0].voterToken, [1]).ok, true);
  assert.equal(store.getVoterByToken(early.voterToken).voter.status, 'approved');

  // Nothing pending: still ok, count 0.
  const again = store.approveAll(poll.adminToken);
  assert.equal(again.ok, true);
  assert.equal(again.count, 0);
});

test('approveAll frees the pending cap but keeps the active count', () => {
  const store = createStore({ limits: { PENDING_MAX: 5, VOTERS_MAX: 12 } });
  const poll = newPoll(store);
  for (let i = 0; i < 5; i++) assert.equal(store.joinPoll(poll.pin, `p${i}`).ok, true);
  assert.match(store.joinPoll(poll.pin, 'extra').error, /waiting/i); // pending cap
  assert.equal(store.approveAll(poll.adminToken).count, 5);
  assert.equal(store.joinPoll(poll.pin, 'extra').ok, true); // pending slots are free again
  assert.equal(store.stats().voters, 6);

  // The active cap still applies to approved + pending together.
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 5; i++) store.joinPoll(poll.pin, `r${round}-${i}`);
    store.approveAll(poll.adminToken);
  }
  assert.equal(store.stats().voters, 12);
  assert.match(store.joinPoll(poll.pin, 'too many').error, /full/i);
});

test('createPoll limits live polls per creator IP and sweep frees them', () => {
  const { store, clock } = setup();
  for (let i = 0; i < LIMITS.POLLS_PER_IP; i++) {
    assert.equal(store.createPoll(VALID_POLL, '10.0.0.1').ok, true);
  }
  const over = store.createPoll(VALID_POLL, '10.0.0.1');
  assert.equal(over.ok, false);
  assert.equal(over.code, 'ip_limit');
  assert.equal(store.createPoll(VALID_POLL, '10.0.0.2').ok, true); // another IP
  assert.equal(store.createPoll(VALID_POLL).ok, true); // no IP given: no per-IP limit

  clock.t += DAY;
  assert.equal(store.createPoll(VALID_POLL, '10.0.0.1').ok, true);
  assert.equal(store.stats().polls, 1);
});

test('global voter cap spans polls and is released by reject and sweep', () => {
  const clock = { t: 1_700_000_000_000 };
  const store = createStore({ now: () => clock.t, limits: { GLOBAL_VOTERS_MAX: 3 } });
  const a = newPoll(store);
  const b = newPoll(store);
  const x1 = store.joinPoll(a.pin, 'x1');
  assert.equal(store.joinPoll(a.pin, 'x2').ok, true);
  assert.equal(store.joinPoll(b.pin, 'y1').ok, true);
  const busy = store.joinPoll(b.pin, 'y2');
  assert.equal(busy.ok, false);
  assert.match(busy.error, /busy/i);

  store.decide(a.adminToken, x1.voterId, false);
  assert.equal(store.stats().voters, 2);
  assert.equal(store.joinPoll(b.pin, 'y2').ok, true);
  assert.equal(store.stats().voters, 3);

  clock.t += DAY;
  store.sweep();
  assert.equal(store.stats().voters, 0);
  assert.equal(store.stats().polls, 0);
});

test('poll and voter ids are 32 hex chars; totalVoted is a counter shared by both views', () => {
  const { store } = setup();
  const poll = newPoll(store);
  assert.match(poll.poll.id, /^[0-9a-f]{32}$/);
  const alice = addVoter(store, poll, 'Alice');
  const bob = addVoter(store, poll, 'Bob');
  addVoter(store, poll, 'Carol');
  assert.match(alice.voterId, /^[0-9a-f]{32}$/);

  assert.equal(store.adminView(poll.poll).totalVoted, 0);
  store.vote(alice.voterToken, [0]);
  store.vote(bob.voterToken, [1]);
  assert.equal(store.vote(bob.voterToken, [2]).ok, false); // a refused vote doesn't move the counter
  assert.equal(store.adminView(poll.poll).totalVoted, 2);

  store.setLive(poll.adminToken, true);
  const view = store.voterView(poll.poll, store.getVoterByToken(alice.voterToken).voter);
  assert.equal(view.results.totalVoted, 2);
  // Carol hasn't voted, so she sees no results even though the counter is 2.
  const carol = [...poll.poll.voters.values()].find((v) => v.name === 'Carol');
  assert.equal(store.voterView(poll.poll, carol).results, null);
});

// ---- pause, edit, maxChoices ----

test('multi polls default maxChoices to the option count and validate an explicit one', () => {
  const { store } = setup();
  const poll = newPoll(store, { multi: true });
  assert.equal(poll.poll.maxChoices, 3);
  assert.equal(store.adminView(poll.poll).maxChoices, 3);
  assert.equal(newPoll(store, { multi: true, maxChoices: null }).poll.maxChoices, 3);
  assert.equal(newPoll(store, { multi: true, maxChoices: 2 }).poll.maxChoices, 2);
  assert.equal(newPoll(store, { multi: true, maxChoices: 3 }).poll.maxChoices, 3);

  for (const maxChoices of [1, 4, 2.5, '3', 0, -2, NaN]) {
    const r = store.createPoll({ title: 'T', options: ['a', 'b', 'c'], multi: true, maxChoices });
    assert.equal(r.ok, false, String(maxChoices));
    assert.match(r.error, /Choose between 2 and 3/);
  }
});

test('single-choice polls ignore maxChoices and report 1', () => {
  const { store } = setup();
  const poll = newPoll(store, { multi: false, maxChoices: 99 });
  assert.equal(store.adminView(poll.poll).maxChoices, 1);
  const v = addVoter(store, poll, 'Alice');
  assert.equal(store.voterView(poll.poll, store.getVoterByToken(v.voterToken).voter).maxChoices, 1);
});

test('vote enforces maxChoices on multi polls', () => {
  const { store } = setup();
  const poll = newPoll(store, { multi: true, maxChoices: 2 });
  const v = addVoter(store, poll, 'Alice');
  const tooMany = store.vote(v.voterToken, [0, 1, 2]);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error, 'Pick at most 2 options');
  assert.equal(store.adminView(poll.poll).totalVoted, 0);
  assert.equal(store.vote(v.voterToken, [0, 2]).ok, true);
  assert.deepEqual(
    store.adminView(poll.poll).options.map((o) => o.count),
    [1, 0, 1]
  );
});

test('setPaused blocks voting until resumed; rejects bad input and closed polls', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const v = addVoter(store, poll, 'Alice');
  assert.equal(store.adminView(poll.poll).paused, false);

  assert.equal(store.setPaused(poll.adminToken, true).ok, true);
  assert.equal(store.adminView(poll.poll).paused, true);
  assert.equal(store.voterView(poll.poll, store.getVoterByToken(v.voterToken).voter).paused, true);
  const blocked = store.vote(v.voterToken, [0]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'Voting is paused');
  assert.equal(store.joinPoll(poll.pin, 'Bob').ok, true); // joining stays open while paused

  assert.equal(store.setPaused(poll.adminToken, false).ok, true);
  assert.equal(store.vote(v.voterToken, [0]).ok, true);

  assert.equal(store.setPaused(poll.adminToken, 'yes').ok, false);
  assert.equal(store.setPaused('wrong', true).ok, false);
  store.closePoll(poll.adminToken);
  const closed = store.setPaused(poll.adminToken, true);
  assert.equal(closed.ok, false);
  assert.equal(closed.error, 'This poll is closed');
});

test('editPoll with only a new title keeps votes and reports reset=false', () => {
  const { store } = setup();
  const poll = newPoll(store, { multi: true, maxChoices: 2 });
  const v = addVoter(store, poll, 'Alice');
  store.vote(v.voterToken, [0, 1]);

  const r = store.editPoll(poll.adminToken, {
    title: 'Dinner?',
    options: ['Pizza', 'Sushi', 'Tacos'],
    multi: true,
    maxChoices: 2,
  });
  assert.equal(r.ok, true);
  assert.equal(r.reset, false);
  const view = store.adminView(poll.poll);
  assert.equal(view.title, 'Dinner?');
  assert.equal(view.totalVoted, 1);
  assert.deepEqual(
    view.options.map((o) => o.count),
    [1, 1, 0]
  );
  const rec = store.getVoterByToken(v.voterToken).voter;
  assert.equal(rec.hasVoted, true);
  assert.deepEqual(rec.choices, [0, 1]);
});

test('editPoll that changes options, multi or maxChoices resets votes; PIN and admin token stay', () => {
  const { store } = setup();
  const poll = newPoll(store, { multi: true, maxChoices: 2 });
  const v = addVoter(store, poll, 'Alice');
  const full = { title: 'Lunch?', options: ['Pizza', 'Sushi', 'Tacos'], multi: true, maxChoices: 2 };

  const check = (edit, label) => {
    const fresh = store.vote(v.voterToken, store.adminView(poll.poll).multi ? [0, 1] : [0]);
    assert.equal(fresh.ok, true, `${label}: ${fresh.error}`);
    const r = store.editPoll(poll.adminToken, { ...full, ...edit });
    assert.equal(r.ok, true, `${label}: ${r.error}`);
    assert.equal(r.reset, true, label);
    const view = store.adminView(poll.poll);
    assert.equal(view.totalVoted, 0, label);
    assert.ok(view.options.every((o) => o.count === 0), label);
    const rec = store.getVoterByToken(v.voterToken).voter;
    assert.equal(rec.hasVoted, false, label);
    assert.equal(rec.choices, null, label);
    assert.equal(view.pin, poll.pin);
    assert.equal(store.getByAdminToken(poll.adminToken), poll.poll);
    assert.equal(store.getByPin(poll.pin), poll.poll);
  };

  check({ options: ['Pizza', 'Sushi', 'Ramen'] }, 'option text');
  full.options = ['Pizza', 'Sushi', 'Ramen'];
  check({ options: ['Ramen', 'Sushi', 'Pizza'] }, 'option order');
  full.options = ['Ramen', 'Sushi', 'Pizza'];
  check({ maxChoices: 3 }, 'maxChoices');
  full.maxChoices = 3;
  check({ multi: false }, 'multi');
  assert.equal(poll.poll.multi, false);
  assert.equal(poll.poll.maxChoices, 1);
  full.multi = false;
  check({ options: ['Ramen', 'Sushi', 'Pizza', 'Curry'] }, 'option count');
  assert.equal(store.adminView(poll.poll).options.length, 4);
});

test('editPoll reopens a paused poll, and a reset voter can vote again', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const v = addVoter(store, poll, 'Alice');
  store.vote(v.voterToken, [0]);
  store.setPaused(poll.adminToken, true);
  const r = store.editPoll(poll.adminToken, { title: 'Lunch?', options: ['Pizza', 'Sushi'], multi: false });
  assert.equal(r.ok, true);
  assert.equal(store.adminView(poll.poll).paused, false);
  assert.equal(store.vote(v.voterToken, [1]).ok, true);
  assert.equal(store.adminView(poll.poll).totalVoted, 1);
});

test('editPoll refuses closed polls, bad tokens and invalid ballots, leaving the poll untouched', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const v = addVoter(store, poll, 'Alice');
  store.vote(v.voterToken, [2]);
  const before = JSON.stringify(store.adminView(poll.poll));

  assert.equal(store.editPoll('wrong', { title: 'T', options: ['a', 'b'] }).ok, false);
  assert.equal(store.editPoll(poll.adminToken, { title: 'T', options: ['only one'] }).ok, false);
  assert.equal(store.editPoll(poll.adminToken, null).ok, false);
  assert.equal(store.editPoll(poll.adminToken, { title: 'T', options: ['a', 'b'], multi: true, maxChoices: 3 }).ok, false);
  assert.equal(JSON.stringify(store.adminView(poll.poll)), before);
  assert.equal(store.getVoterByToken(v.voterToken).voter.hasVoted, true);

  store.closePoll(poll.adminToken);
  const closed = store.editPoll(poll.adminToken, { title: 'T', options: ['a', 'b'] });
  assert.equal(closed.ok, false);
  assert.equal(closed.error, 'This poll is closed');
});

test('a vote carrying a stale revision is refused after an option-changing edit', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const alice = addVoter(store, poll, 'Alice');
  const rev0 = store.voterView(poll.poll, store.getVoterByToken(alice.voterToken).voter).revision;
  assert.equal(rev0, 0);

  assert.equal(store.editPoll(poll.adminToken, { title: 'Lunch?', options: ['Ramen', 'Pizza', 'Tacos'] }).reset, true);
  const stale = store.vote(alice.voterToken, [0], rev0);
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'The host changed the poll. Vote again.');
  assert.equal(store.adminView(poll.poll).totalVoted, 0);
  assert.ok(store.adminView(poll.poll).options.every((o) => o.count === 0));
  assert.equal(store.getVoterByToken(alice.voterToken).voter.hasVoted, false);

  const current = store.vote(alice.voterToken, [0], store.adminView(poll.poll).revision);
  assert.equal(current.ok, true, current.error);
  assert.equal(store.adminView(poll.poll).options[0].count, 1);
});

test('a title-only edit keeps the revision; a vote without a revision still works', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const alice = addVoter(store, poll, 'Alice');
  const edit = store.editPoll(poll.adminToken, { title: 'Dinner?', options: ['Pizza', 'Sushi', 'Tacos'] });
  assert.equal(edit.reset, false);
  assert.equal(store.adminView(poll.poll).revision, 0);
  assert.equal(store.vote(alice.voterToken, [1], 0).ok, true);

  const bob = addVoter(store, poll, 'Bob');
  assert.equal(store.vote(bob.voterToken, [2]).ok, true);
});

// ---- name keys and removing voters ----

test('names collide after removing spaces and ignoring case', () => {
  const { store } = setup();
  const poll = newPoll(store);
  addVoter(store, poll, 'Alice Smith');
  assert.equal(store.joinPoll(poll.pin, 'alicesmith').ok, false);
  assert.equal(store.joinPoll(poll.pin, 'A L I C E SMITH').ok, false);
  assert.equal(store.joinPoll(poll.pin, 'ALICE\u00A0SMITH').ok, false);
  assert.equal(store.joinPoll(poll.pin, 'Alice Smyth').ok, true);
});

test('removeVoter: approved voter who has not voted', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const alice = addVoter(store, poll, 'Alice');
  addVoter(store, poll, 'Bob');
  assert.equal(poll.poll.activeCount, 2);

  const r = store.removeVoter(poll.adminToken, alice.voterId);
  assert.equal(r.ok, true);
  assert.equal(r.keptVote, false);
  assert.equal(r.voter.status, 'removed');
  assert.equal(poll.poll.activeCount, 1);
  assert.equal(store.getVoterByToken(alice.voterToken), null);
  assert.equal(store.adminView(poll.poll).approved.some((v) => v.name === 'Alice'), false);
  assert.equal(store.voterView(poll.poll, r.voter).status, 'removed');
  assert.deepEqual(store.voterView(poll.poll, r.voter).options, []);
  assert.equal(store.joinPoll(poll.pin, 'a lice').ok, true); // the name is free again
});

test('removeVoter takes a recorded vote out of the tallies', () => {
  const { store } = setup();
  const poll = newPoll(store, { multi: true });
  const alice = addVoter(store, poll, 'Alice');
  const bob = addVoter(store, poll, 'Bob');
  assert.equal(store.vote(alice.voterToken, [0, 2]).ok, true);
  assert.equal(store.vote(bob.voterToken, [0]).ok, true);
  store.setLive(poll.adminToken, true);

  const r = store.removeVoter(poll.adminToken, alice.voterId);
  assert.equal(r.ok, true);
  assert.equal(r.keptVote, false);
  const view = store.adminView(poll.poll);
  assert.deepEqual(view.options.map((o) => o.count), [1, 0, 0]);
  assert.equal(view.totalVoted, 1);
  // A removed voter who had voted never sees results.
  assert.equal(store.voterView(poll.poll, r.voter).results, null);
});

test('removeVoter in an anonymous poll keeps the vote counted', () => {
  const { store } = setup();
  const poll = newPoll(store, { anonymous: true });
  const alice = addVoter(store, poll, 'Alice');
  assert.equal(store.vote(alice.voterToken, [1]).ok, true);

  const r = store.removeVoter(poll.adminToken, alice.voterId);
  assert.equal(r.ok, true);
  assert.equal(r.keptVote, true);
  const view = store.adminView(poll.poll);
  assert.deepEqual(view.options.map((o) => o.count), [0, 1, 0]);
  assert.equal(view.totalVoted, 1);
});

test('removeVoter refuses pending voters, unknown ids and wrong tokens', () => {
  const { store } = setup();
  const poll = newPoll(store);
  const pending = addVoter(store, poll, 'Alice', false);
  const approved = addVoter(store, poll, 'Bob');

  assert.match(store.removeVoter(poll.adminToken, pending.voterId).error, /approved/i);
  assert.match(store.removeVoter(poll.adminToken, 'nope').error, /not found/i);
  assert.match(store.removeVoter(poll.adminToken, 42).error, /not found/i);
  assert.match(store.removeVoter('wrong', approved.voterId).error, /Poll not found/);
  assert.equal(store.removeVoter(poll.adminToken, approved.voterId).ok, true);
  // Already gone.
  assert.match(store.removeVoter(poll.adminToken, approved.voterId).error, /not found/i);
});

test('removeVoter frees the per-poll and global slots', () => {
  const store = createStore({ limits: { VOTERS_MAX: 1, GLOBAL_VOTERS_MAX: 1 } });
  const poll = newPoll(store);
  const alice = addVoter(store, poll, 'Alice');
  assert.match(store.joinPoll(poll.pin, 'Bob').error, /busy|full/i);
  assert.equal(store.stats().voters, 1);

  assert.equal(store.removeVoter(poll.adminToken, alice.voterId).ok, true);
  assert.equal(store.stats().voters, 0);
  assert.equal(store.joinPoll(poll.pin, 'Bob').ok, true);
});
