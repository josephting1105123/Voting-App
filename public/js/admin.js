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
  var pauseBusy = false;
  var resultsShown = false; // results stay hidden until the host reveals them, so the screen can be projected

  var errorBox = $('admin-error');
  var pendingList = $('pending-list');
  var votersList = $('voters-list');
  var closeBtn = $('close-btn');
  var liveSwitch = $('live-switch');
  var pauseSwitch = $('pause-switch');
  var editBtn = $('edit-btn');
  var editDialog = $('edit-dialog');
  var closeDialog = $('close-dialog');
  var approveAllBtn = $('approve-all');
  var PENDING_VISIBLE = 3; // rows shown in the card; the rest live in the dialog
  var pendingMoreBtn = $('pending-more');
  var pendingDialog = $('pending-dialog');
  var pendingDialogList = $('pending-dialog-list');
  var pendingDialogApproveAll = $('pending-dialog-approve-all');

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
    var known = QV.loadAdminPolls().filter(function (p) {
      return p.adminToken === token;
    })[0];
    if (!known) QV.saveAdminPoll({ pin: s.pin, title: s.title, adminToken: token, createdAt: Date.now() });
    // A renamed poll keeps its original createdAt (saveAdminPoll moves the entry to the front of the list).
    else if (known.title !== s.title) QV.saveAdminPoll({ pin: known.pin, title: s.title, adminToken: token, createdAt: known.createdAt });
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
    $('paused-badge').hidden = !(s.paused && !s.closed);
    var modeText = 'Single choice';
    if (s.multi) {
      modeText = s.maxChoices && s.maxChoices < s.options.length ? 'Pick up to ' + s.maxChoices : 'Multiple choice';
    }
    $('mode-badge').textContent = modeText;
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
    pauseSwitch.setAttribute('aria-checked', s.paused ? 'true' : 'false');

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
    editBtn.hidden = s.closed;
    $('pause-row').hidden = s.closed;
    $('closed-note').hidden = !s.closed;
    if (s.closed) {
      if (editDialog.open) editDialog.close();
      if (closeDialog.open) closeDialog.close();
    }
  }

  function renderPending(s) {
    var n = s.pending.length;
    var heading = 'Pending (' + n + ')';
    var approveAllText = 'Approve all (' + n + ')';
    $('pending-heading').textContent = heading;
    $('pending-empty').hidden = n > 0;
    approveAllBtn.hidden = n < 2;
    approveAllBtn.textContent = approveAllText;
    pendingMoreBtn.hidden = n <= PENDING_VISIBLE;
    pendingMoreBtn.textContent = 'Show ' + (n - PENDING_VISIBLE) + ' more waiting';
    QV.reconcile(pendingList, s.pending.slice(0, PENDING_VISIBLE), pendingKey, createPendingItem, updatePendingItem);

    $('pending-dialog-heading').textContent = heading;
    $('pending-dialog-empty').hidden = n > 0;
    pendingDialogApproveAll.hidden = n < 2;
    pendingDialogApproveAll.textContent = approveAllText;
    QV.reconcile(pendingDialogList, s.pending, pendingKey, createPendingItem, updatePendingItem);
    if (n === 0 && pendingDialog.open) pendingDialog.close();
  }

  function pendingKey(p) {
    return p.id;
  }

  function updatePendingItem(li, p) {
    li._nameEl.textContent = p.name;
    li._avatar.textContent = (Array.from(p.name)[0] || '?').toUpperCase();
  }

  function createPendingItem(p) {
    var nameEl = el('span', { class: 'item-name' });
    var avatar = el('span', { class: 'avatar', 'aria-hidden': 'true' });
    var approveBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Approve');
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

  $('pause-row').addEventListener('click', function () {
    if (!state || pauseBusy) return;
    pauseBusy = true;
    var pausing = !state.paused;
    QV.emitAck(socket, 'admin:setPaused', { paused: pausing }).then(function (res) {
      pauseBusy = false;
      setError(res.ok ? '' : res.error || (pausing ? 'Could not pause voting.' : 'Could not resume voting.'));
    });
  });

  // Clicking the dimmed backdrop (the dialog element itself, outside its box) closes it.
  function wireDialog(dialog) {
    dialog.addEventListener('click', function (e) {
      if (e.target !== dialog) return;
      var r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        dialog.close();
      }
    });
  }

  var editConfirm = $('edit-confirm');

  function resetEditConfirm() {
    editConfirm.disabled = false;
    editConfirm.textContent = 'Pause and edit';
  }

  var editError = $('edit-error');
  var closeError = $('close-error');

  editBtn.addEventListener('click', function () {
    resetEditConfirm();
    editError.hidden = true;
    editDialog.showModal();
    $('edit-cancel').focus();
  });

  $('edit-cancel').addEventListener('click', function () {
    editDialog.close();
  });

  editConfirm.addEventListener('click', function () {
    editConfirm.disabled = true;
    editConfirm.textContent = 'Pausing…';
    editError.hidden = true;
    QV.emitAck(socket, 'admin:setPaused', { paused: true }).then(function (res) {
      if (res.ok) {
        location.href = '/create.html#edit=' + token;
      } else {
        editError.textContent = res.error || 'Could not pause voting.';
        editError.hidden = false;
        resetEditConfirm();
      }
    });
  });

  var closeConfirm = $('close-confirm');

  closeBtn.addEventListener('click', function () {
    closeConfirm.disabled = false;
    closeError.hidden = true;
    closeDialog.showModal();
    $('close-cancel').focus();
  });

  $('close-cancel').addEventListener('click', function () {
    closeDialog.close();
  });

  closeConfirm.addEventListener('click', function () {
    closeConfirm.disabled = true;
    closeError.hidden = true;
    QV.emitAck(socket, 'admin:close', {}).then(function (res) {
      closeConfirm.disabled = false;
      if (res.ok) {
        closeDialog.close();
        setError('');
      } else {
        closeError.textContent = res.error || 'Could not close the poll.';
        closeError.hidden = false;
      }
    });
  });

  wireDialog(editDialog);
  wireDialog(closeDialog);

  function approveAll(btn) {
    btn.disabled = true;
    QV.emitAck(socket, 'admin:approveAll', {}).then(function (res) {
      btn.disabled = false;
      setError(res.ok ? '' : res.error || 'Could not approve everyone.');
    });
  }

  approveAllBtn.addEventListener('click', function () {
    approveAll(approveAllBtn);
  });
  pendingDialogApproveAll.addEventListener('click', function () {
    approveAll(pendingDialogApproveAll);
  });

  pendingMoreBtn.addEventListener('click', function () {
    if (!pendingDialog.open) pendingDialog.showModal();
  });
  $('pending-dialog-close').addEventListener('click', function () {
    pendingDialog.close();
  });
  wireDialog(pendingDialog);

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

  var MASK = '••••••••••••••••••••';
  var cohostDialog = $('cohost-dialog');
  var cohostLink = $('cohost-link');
  var cohostCopy = $('cohost-copy');
  var cohostReveal = $('cohost-reveal');

  function setSwap(btn, on) {
    if (on) btn.dataset.on = '1';
    else delete btn.dataset.on;
    var a = btn.querySelector('.swap-a');
    var b = btn.querySelector('.swap-b');
    if (a) a.setAttribute('aria-hidden', on ? 'true' : 'false');
    if (b) b.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  function setRevealed(on) {
    cohostReveal.setAttribute('aria-pressed', on ? 'true' : 'false');
    cohostLink.value = on ? location.href : MASK;
    cohostLink.setAttribute('aria-label', on ? 'Co-host link' : 'Co-host link (hidden)');
  }

  function resetCohost() {
    setRevealed(false);
    clearTimeout(cohostCopy._timer);
    setSwap(cohostCopy, false);
    $('cohost-status').textContent = '';
  }

  $('cohost-open').addEventListener('click', function () {
    resetCohost();
    cohostDialog.showModal();
  });

  cohostReveal.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    setRevealed(true);
    try {
      cohostReveal.setPointerCapture(e.pointerId);
    } catch (err) {
      /* capture is best effort */
    }
  });
  ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'].forEach(function (name) {
    cohostReveal.addEventListener(name, function () {
      setRevealed(false);
    });
  });
  cohostReveal.addEventListener('keydown', function (e) {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      setRevealed(true);
    }
  });
  cohostReveal.addEventListener('keyup', function (e) {
    if (e.key === ' ' || e.key === 'Enter') setRevealed(false);
  });
  cohostReveal.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });

  cohostCopy.addEventListener('click', function () {
    QV.copyToClipboard(location.href).then(function (ok) {
      if (ok) {
        clearTimeout(cohostCopy._timer);
        setSwap(cohostCopy, true);
        $('cohost-status').textContent = 'Link copied';
        cohostCopy._timer = setTimeout(function () {
          setSwap(cohostCopy, false);
          $('cohost-status').textContent = '';
        }, 1500);
      } else {
        setRevealed(true);
        cohostLink.select();
      }
    });
  });

  $('cohost-done').addEventListener('click', function () {
    cohostDialog.close();
  });

  wireDialog(cohostDialog);

  cohostLink.addEventListener('copy', function (e) {
    if (cohostReveal.getAttribute('aria-pressed') === 'true') return;
    e.preventDefault();
    if (e.clipboardData) e.clipboardData.setData('text/plain', location.href);
  });

  cohostDialog.addEventListener('close', resetCohost);
})();
