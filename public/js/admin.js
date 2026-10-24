(function () {
  'use strict';

  var QV = window.QV;
  var $ = QV.$;
  var el = QV.el;

  // Built at runtime so an engine without Unicode property escapes falls back instead of failing to parse the page.
  var NOT_WORD;
  try {
    NOT_WORD = new RegExp('[^\\p{L}\\p{N}\\p{M}]', 'gu');
  } catch (e) {
    NOT_WORD = /[\s!-\/:-@\[-`{-~]/g;
  }

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

  // Names that only differ by spaces or case can't both join (the server refuses them). This looser key also
  // ignores punctuation and symbols, so "John." and "John!" are flagged for the host to check.
  function lookKey(name) {
    return name.normalize('NFKC').replace(/[\u200C\u200D]/g, '').toUpperCase().replace(NOT_WORD, '');
  }

  // Lookalike names first (grouped together), then people who haven't voted, then people who have.
  function sortVoters(list) {
    var keys = list.map(function (v) {
      return lookKey(v.name);
    });
    var seen = new Map();
    keys.forEach(function (k) {
      if (k) seen.set(k, (seen.get(k) || 0) + 1);
    });
    var dupIds = new Set();
    var items = list.map(function (v, i) {
      var dup = keys[i] !== '' && seen.get(keys[i]) >= 2;
      if (dup) dupIds.add(v.id);
      return { v: v, i: i, key: keys[i], rank: dup ? 0 : v.hasVoted ? 2 : 1 };
    });
    items.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank === 0 && a.key !== b.key) return a.key < b.key ? -1 : 1;
      return a.i - b.i;
    });
    var rows = items.map(function (it) {
      return it.v;
    });
    var groups = rows.filter(function (v) {
      return dupIds.has(v.id);
    });
    return { rows: rows, dupIds: dupIds, groups: groups };
  }

  function voterKey(v) {
    return v.id;
  }

  // Shared by the card and the dialog; `withRemove` adds the Remove button and keeps the row on one line.
  function createVoterRow(withRemove) {
    var nameEl = el('span', { class: 'item-name' });
    var avatar = el('span', { class: 'avatar', 'aria-hidden': 'true' });
    var badge = el('span', { class: 'badge' });
    var dupEl = el('span', { class: 'sr-only' });
    var main = el('div', { class: 'item-main voter-main' }, avatar, nameEl, dupEl, badge);
    var li = el('li', { class: 'list-item voter-row' + (withRemove ? ' voter-row-dialog' : '') }, main);
    li._nameEl = nameEl;
    li._avatar = avatar;
    li._badge = badge;
    li._dupEl = dupEl;
    if (withRemove) {
      var removeBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Remove');
      li.appendChild(el('div', { class: 'item-actions' }, removeBtn));
      li._removeBtn = removeBtn;
      removeBtn.addEventListener('click', function () {
        removeVoter(li);
      });
    } else {
      var sub = el('p', { class: 'item-sub muted small', hidden: true });
      li.appendChild(sub);
      li._sub = sub;
    }
    return li;
  }

  function updateVoterRow(li, v, isDup) {
    li._voter = v;
    li._nameEl.textContent = v.name;
    li._nameEl.title = v.name;
    li._avatar.textContent = (Array.from(v.name)[0] || '?').toUpperCase();
    li._avatar.className = isDup ? 'avatar avatar-dup' : 'avatar';
    li._dupEl.textContent = isDup ? ' (possible duplicate)' : '';
    li._badge.textContent = v.hasVoted ? 'Voted' : 'Not yet';
    li._badge.className = v.hasVoted ? 'badge badge-ok' : 'badge';
    if (li._removeBtn) {
      li._removeBtn.setAttribute('aria-label', 'Remove ' + v.name);
      li._removeBtn.disabled = removing.has(v.id);
    }
  }

  // Ids with a remove request in flight, so both of a lookalike's buttons lock together.
  var removing = new Set();
  // Where the removed row sat, so focus can land on its neighbour once the new state arrives.
  var pendingFocus = null;

  function removeVoter(li) {
    var v = li._voter;
    if (!v || removing.has(v.id)) return;
    var text;
    if (v.hasVoted && Array.isArray(v.choices)) {
      text = 'Remove ' + v.name + ' from this poll? Their vote will come out of the results.';
    } else if (v.hasVoted) {
      text = 'Remove ' + v.name + " from this poll? This poll is anonymous, so their vote can't be traced and stays in the results.";
    } else {
      text = 'Remove ' + v.name + ' from this poll?';
    }
    if (!window.confirm(text)) return;
    var list = li.parentNode;
    removing.add(v.id);
    pendingFocus = { id: v.id, listId: list.id, index: Array.prototype.indexOf.call(list.children, li) };
    Array.prototype.forEach.call(document.querySelectorAll('#voters-dialog .voter-row'), function (row) {
      if (row._voter && row._voter.id === v.id) row._removeBtn.disabled = true;
    });
    QV.emitAck(socket, 'admin:remove', { voterId: v.id }).then(function (res) {
      if (res.ok) {
        setVotersError('');
        $('voters-status').textContent = 'Removed ' + v.name;
      } else {
        var msg = res.error || 'Could not remove that voter.';
        removing.delete(v.id);
        pendingFocus = null;
        setVotersError(msg);
        setError(msg);
        Array.prototype.forEach.call(document.querySelectorAll('#voters-dialog .voter-row'), function (row) {
          if (row._voter && row._voter.id === v.id) row._removeBtn.disabled = false;
        });
      }
    });
  }

  // After a removal the clicked button is gone: move focus to whichever row now sits at the same spot.
  function restoreFocus(rows) {
    if (!pendingFocus) return;
    var gone = !rows.some(function (v) {
      return v.id === pendingFocus.id;
    });
    if (!gone) return;
    removing.delete(pendingFocus.id);
    var target = null;
    var list = $(pendingFocus.listId);
    var row = list && list.children[pendingFocus.index];
    if (row && row._removeBtn && !row._removeBtn.disabled) target = row._removeBtn;
    pendingFocus = null;
    if (!$('voters-dialog').open) return;
    (target || $('voters-done')).focus();
  }

  function setVotersError(message) {
    var p = $('voters-dialog-error');
    p.textContent = message;
    p.hidden = !message;
  }

  function renderVoters(s) {
    var sorted = sortVoters(s.approved);
    var count = s.approved.length;
    $('voters-heading').textContent = 'Voters (' + count + ')';
    $('voters-empty').hidden = count > 0;
    $('voters-open').hidden = count === 0;
    $('voters-tile').classList.toggle('is-openable', count > 0);

    var dupNote = $('voters-dup-note');
    dupNote.hidden = sorted.groups.length === 0;
    dupNote.textContent = sorted.groups.length + (sorted.groups.length === 1 ? ' name looks alike' : ' names look alike');

    var optionText = new Map();
    s.options.forEach(function (o) {
      optionText.set(o.id, o.text);
    });

    QV.reconcile(
      votersList,
      sorted.rows,
      voterKey,
      function () {
        return createVoterRow(false);
      },
      function (li, v) {
        updateVoterRow(li, v, sorted.dupIds.has(v.id));
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

    // The dialog stays live while open: same rows, plus a Remove button on each.
    $('voters-dialog-title').textContent = 'Voters (' + count + ')';
    $('all-heading').textContent = 'All participants (' + count + ')';
    $('dup-empty').hidden = sorted.groups.length > 0;
    $('all-empty').hidden = count > 0;
    [
      [$('dup-list'), sorted.groups],
      [$('all-list'), sorted.rows]
    ].forEach(function (pair) {
      QV.reconcile(
        pair[0],
        pair[1],
        voterKey,
        function () {
          return createVoterRow(true);
        },
        function (li, v) {
          updateVoterRow(li, v, sorted.dupIds.has(v.id));
        }
      );
    });
    restoreFocus(sorted.rows);

    // Show exactly four rows however tall they are (picks make some rows taller); the CSS height is the fallback.
    if (votersList.children.length > 4) {
      votersList.style.maxHeight = votersList.children[4].offsetTop - votersList.children[0].offsetTop + 'px';
    } else {
      votersList.style.maxHeight = '';
    }

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

  var votersDialog = $('voters-dialog');

  // The whole card opens the manager (the Manage button's click bubbles here), unless the host is selecting text.
  $('voters-tile').addEventListener('click', function (e) {
    if (!state || state.approved.length === 0) return;
    var viaButton = e.target.closest && e.target.closest('#voters-open');
    var sel = window.getSelection ? window.getSelection().toString() : '';
    if (sel && !viaButton) return;
    setVotersError('');
    if (!votersDialog.open) votersDialog.showModal();
  });

  $('voters-done').addEventListener('click', function () {
    votersDialog.close();
  });

  votersDialog.addEventListener('click', function (e) {
    if (e.target !== votersDialog || e.detail > 1) return;
    var r = votersDialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      votersDialog.close();
    }
  });
})();
