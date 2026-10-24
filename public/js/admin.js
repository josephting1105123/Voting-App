(function () {
  'use strict';

  var QV = window.QV;
  var $ = QV.$;
  var el = QV.el;

  var token = location.hash.slice(1).trim();
  var panels = { loading: $('loading'), notFound: $('not-found'), admin: $('admin') };

  function show(which) {
    Object.keys(panels).forEach(function (name) {
      panels[name].hidden = name !== which;
    });
  }

  window.addEventListener('hashchange', function () {
    location.reload();
  });

  if (!token) {
    show('notFound');
    return;
  }

  // /socket.io/socket.io.js is network-only, so `io` doesn't exist when the page is opened offline.
  if (typeof io === 'undefined') {
    $('loading').textContent = "You're offline — reconnect and reload.";
    show('loading');
    return;
  }

  QV.keepAlive();

  var socket = io();
  QV.watchConnection(socket, $('conn'));

  var state = null;
  var dead = false; // auth said "not found": stop reacting to anything
  var liveBusy = false;
  var resultsShown = false; // results stay hidden until the host reveals them, so the screen can be projected

  var errorBox = $('admin-error');
  var pendingList = $('pending-list');
  var votersList = $('voters-list');
  var closeBtn = $('close-btn');
  var liveSwitch = $('live-switch');
  var approveAllBtn = $('approve-all');

  // Errors show in a fixed bottom toast so they're visible wherever the host has scrolled to.
  // It hides itself after 6 seconds, or when dismissed; a newer message restarts the timer.
  var errorText = $('admin-error-text');
  var errorTimer = null;

  function setError(message) {
    clearTimeout(errorTimer);
    errorTimer = null;
    errorText.textContent = message || '';
    errorBox.hidden = !message;
    if (message) {
      errorTimer = setTimeout(function () {
        errorBox.hidden = true;
      }, 6000);
    }
  }

  $('admin-error-close').addEventListener('click', function () {
    setError('');
  });

  /* ---- socket wiring ---- */

  socket.on('connect', function () {
    // Runs on first connect and on every reconnect.
    QV.emitAck(socket, 'admin:auth', { token: token }).then(function (res) {
      if (res.ok && res.state) {
        dead = false;
        setError('');
        remember(res.state);
        render(res.state);
      } else if (res.error === 'not found') {
        dead = true;
        QV.forgetAdminPoll(token);
        show('notFound');
        socket.disconnect();
      } else {
        setError(res.error || 'Could not sign in as admin.');
      }
    });
  });

  socket.on('admin:state', function (s) {
    if (!dead) render(s);
  });

  function remember(s) {
    var known = QV.loadAdminPolls().some(function (p) {
      return p.adminToken === token;
    });
    if (!known) QV.saveAdminPoll({ pin: s.pin, title: s.title, adminToken: token, createdAt: Date.now() });
  }

  /* ---- rendering ---- */

  function pluralVotes(n) {
    return n + (n === 1 ? ' vote' : ' votes');
  }

  function render(s) {
    state = s;
    show('admin');
    document.title = s.title + ' - Quick Vote';

    $('poll-title').textContent = s.title;
    $('closed-badge').hidden = !s.closed;
    $('mode-badge').textContent = s.multi ? 'Multiple choice' : 'Single choice';
    $('anon-badge').textContent = s.anonymous ? 'Anonymous' : 'Names visible to you';

    var pinEl = $('pin');
    if (pinEl.getAttribute('data-pin') !== s.pin) {
      pinEl.setAttribute('data-pin', s.pin);
      pinEl.setAttribute('aria-label', 'PIN ' + s.pin.split('').join(' '));
      while (pinEl.firstChild) pinEl.removeChild(pinEl.firstChild);
      s.pin.split('').forEach(function (d) {
        pinEl.appendChild(el('span', { class: 'pin-digit', 'aria-hidden': 'true', text: d }));
      });
    }
    var link = location.origin + '/?pin=' + s.pin;
    if ($('share-link').value !== link) $('share-link').value = link;

    liveSwitch.setAttribute('aria-checked', s.live ? 'true' : 'false');

    $('total').textContent = pluralVotes(s.totalVoted) + ' so far';
    QV.renderResults($('results'), s.options, { options: s.options, totalVoted: s.totalVoted });
    $('results').hidden = !resultsShown;
    $('results-hidden-note').hidden = resultsShown;
    $('multi-note').hidden = !s.multi || !resultsShown;
    $('results-toggle').textContent = resultsShown ? 'Hide results' : 'Show results';
    $('results-toggle').setAttribute('aria-expanded', resultsShown ? 'true' : 'false');

    renderPending(s);
    renderVoters(s);

    closeBtn.hidden = s.closed;
    $('closed-note').hidden = !s.closed;
  }

  function renderPending(s) {
    $('pending-heading').textContent = 'Pending (' + s.pending.length + ')';
    $('pending-empty').hidden = s.pending.length > 0;
    approveAllBtn.hidden = s.pending.length < 2;
    approveAllBtn.textContent = 'Approve all (' + s.pending.length + ')';
    QV.reconcile(
      pendingList,
      s.pending,
      function (p) {
        return p.id;
      },
      createPendingItem,
      function (li, p) {
        li._nameEl.textContent = p.name;
        li._avatar.textContent = (Array.from(p.name)[0] || '?').toUpperCase();
      }
    );
  }

  function createPendingItem(p) {
    var nameEl = el('span', { class: 'item-name' });
    var avatar = el('span', { class: 'avatar', 'aria-hidden': 'true' });
    var approveBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Approve');
    var rejectBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Reject');
    approveBtn.setAttribute('aria-label', 'Approve ' + p.name);
    rejectBtn.setAttribute('aria-label', 'Reject ' + p.name);

    function decide(approve) {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      QV.emitAck(socket, 'admin:decide', { voterId: p.id, approve: approve }).then(function (res) {
        if (res.ok) {
          setError('');
        } else {
          setError(res.error || 'Could not update that voter.');
          approveBtn.disabled = false;
          rejectBtn.disabled = false;
        }
      });
    }
    approveBtn.addEventListener('click', function () {
      decide(true);
    });
    rejectBtn.addEventListener('click', function () {
      decide(false);
    });

    var li = el('li', { class: 'list-item' }, el('div', { class: 'item-main' }, avatar, nameEl), el('div', { class: 'item-actions' }, approveBtn, rejectBtn));
    li._nameEl = nameEl;
    li._avatar = avatar;
    return li;
  }

  function renderVoters(s) {
    $('voters-heading').textContent = 'Voters (' + s.approved.length + ')';
    $('voters-empty').hidden = s.approved.length > 0;

    var optionText = new Map();
    s.options.forEach(function (o) {
      optionText.set(o.id, o.text);
    });

    QV.reconcile(
      votersList,
      s.approved,
      function (v) {
        return v.id;
      },
      function () {
        var nameEl = el('span', { class: 'item-name' });
        var avatar = el('span', { class: 'avatar', 'aria-hidden': 'true' });
        var badge = el('span', { class: 'badge' });
        var sub = el('p', { class: 'item-sub muted small', hidden: true });
        var li = el('li', { class: 'list-item' }, el('div', { class: 'item-main' }, avatar, nameEl, badge, sub));
        li._nameEl = nameEl;
        li._avatar = avatar;
        li._badge = badge;
        li._sub = sub;
        return li;
      },
      function (li, v) {
        li._nameEl.textContent = v.name;
        li._avatar.textContent = (Array.from(v.name)[0] || '?').toUpperCase();
        li._badge.textContent = v.hasVoted ? 'Voted' : 'Not yet';
        li._badge.className = v.hasVoted ? 'badge badge-ok' : 'badge';
        // Anonymous polls never send `choices`, so there is nothing to show.
        var picks = Array.isArray(v.choices)
          ? v.choices.map(function (id) {
              return optionText.get(id);
            })
          : [];
        picks = picks.filter(Boolean);
        li._sub.textContent = picks.join(', ');
        li._sub.hidden = picks.length === 0 || !resultsShown;
      }
    );

    var note = $('rejected-note');
    note.hidden = s.rejectedCount === 0;
    note.textContent = s.rejectedCount + (s.rejectedCount === 1 ? ' request declined' : ' requests declined');
  }

  /* ---- actions ---- */

  // Reveal or hide the results (and each voter's picks); the choice resets on reload.
  $('results-toggle').addEventListener('click', function () {
    resultsShown = !resultsShown;
    if (state) render(state);
  });

  // The whole row toggles the switch (bigger tap target); the button's own click bubbles here.
  $('live-row').addEventListener('click', function () {
    if (!state || liveBusy) return;
    liveBusy = true;
    QV.emitAck(socket, 'admin:setLive', { live: !state.live }).then(function (res) {
      liveBusy = false;
      setError(res.ok ? '' : res.error || 'Could not change the Live setting.');
    });
  });

  closeBtn.addEventListener('click', function () {
    if (!window.confirm('Close this poll? No one will be able to join or vote after this.')) return;
    closeBtn.disabled = true;
    QV.emitAck(socket, 'admin:close', {}).then(function (res) {
      closeBtn.disabled = false;
      setError(res.ok ? '' : res.error || 'Could not close the poll.');
    });
  });

  approveAllBtn.addEventListener('click', function () {
    approveAllBtn.disabled = true;
    QV.emitAck(socket, 'admin:approveAll', {}).then(function (res) {
      approveAllBtn.disabled = false;
      setError(res.ok ? '' : res.error || 'Could not approve everyone.');
    });
  });

  function wireCopy(button, getText, source) {
    button.addEventListener('click', function () {
      QV.copyToClipboard(getText()).then(function (ok) {
        QV.flash(button, ok ? 'Copied ✓' : 'Copy failed');
        if (!ok && source) source.select();
      });
    });
  }

  wireCopy($('copy-share'), function () {
    return $('share-link').value;
  }, $('share-link'));
  wireCopy($('copy-admin'), function () {
    return location.href;
  });
})();
