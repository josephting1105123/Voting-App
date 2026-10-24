(function () {
  'use strict';

  var QV = window.QV;
  var $ = QV.$;
  var el = QV.el;

  var params = new URLSearchParams(location.search);
  var pin = (params.get('pin') || '').trim();
  var name = (params.get('name') || '').trim();

  if (!/^\d{6}$/.test(pin)) {
    location.replace('/');
    return;
  }
  if (!QV.getVoterToken(pin) && !name) {
    location.replace('/?pin=' + encodeURIComponent(pin));
    return;
  }

  var view = $('view');

  // /socket.io/socket.io.js is network-only, so `io` doesn't exist when the page is opened offline.
  if (typeof io === 'undefined') {
    QV.clear(view);
    view.appendChild(
      el(
        'div',
        { class: 'card center', role: 'status' },
        el('p', null, "You're offline — reconnect and reload."),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: function () { location.reload(); } }, 'Reload')
      )
    );
    return;
  }

  var srStatus = $('sr-status');
  var socket = io();
  QV.watchConnection(socket, $('conn'));

  QV.keepAlive();

  var busy = false; // a join/resume is in flight
  var fatal = false; // a join failed for good (or we were rejected); ignore further state and reconnects
  var current = { mode: null, update: null };

  var ANNOUNCE = {
    pending: 'Waiting for the host to let you in.',
    rejected: 'Your request was declined.',
    removed: 'The host removed you from this poll.',
    ballot: 'You are in. Choose your answer.',
    voted: 'Vote recorded.',
    closed: 'This poll is closed.',
    paused: 'Voting is paused.',
  };
  var CHANGED_NOTICE = 'The host changed the poll, so your earlier vote was cleared. Vote again.';
  var OPTIONS_CHANGED_NOTICE = 'The host changed the options. Check your choices before you vote.';

  /* ---- connection flow ---- */

  socket.on('connect', bootstrap);

  socket.on('voter:state', function (s) {
    if (!fatal) render(s);
  });

  function bootstrap() {
    if (fatal || busy) return;
    var stored = QV.getVoterToken(pin);
    if (stored) resume(stored);
    else join();
  }

  function sameName(a, b) {
    function nameKey(s) {
      return s.normalize('NFKC').replace(/[‌‍]/g, '').toLowerCase().replace(/\s+/g, '').toUpperCase();
    }
    return nameKey(a) === nameKey(b);
  }

  function resume(stored) {
    busy = true;
    QV.emitAck(socket, 'voter:resume', { voterToken: stored }).then(function (res) {
      busy = false;
      if (res.ok && res.state) {
        // Someone typed a different name for this PIN on the same browser: treat it as a new join.
        // The old token stays in place until the new join succeeds, so a failed join can't strand them.
        if (name && !sameName(res.state.name, name)) {
          join();
          return;
        }
        render(res.state);
      } else if (res.error === 'not found') {
        QV.clearVoterToken(pin);
        if (name) join();
        else showError("We couldn't find your spot in this poll. It may have expired.");
      } else {
        showError(res.error || 'Could not reconnect.', { retry: true });
      }
    });
  }

  // One random key per browser tab and PIN. If a join's reply is lost and we send it again, the server
  // recognises the key and hands back the same voter instead of answering "name already taken".
  function joinKey() {
    var k = null;
    try {
      k = sessionStorage.getItem('qv:joinKey:' + pin);
    } catch (e) {
      k = null;
    }
    if (!/^[0-9a-f]{32}$/.test(k || '')) {
      try {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        k = Array.prototype.map
          .call(bytes, function (b) {
            return ('0' + b.toString(16)).slice(-2);
          })
          .join('');
        sessionStorage.setItem('qv:joinKey:' + pin, k);
      } catch (e) {
        return undefined; // no crypto or storage: join without a key (old behaviour)
      }
    }
    return k;
  }

  function join() {
    busy = true;
    QV.emitAck(socket, 'voter:join', { pin: pin, name: name, joinKey: joinKey() }).then(function (res) {
      busy = false;
      if (res.ok && res.voterToken) {
        QV.setVoterToken(pin, res.voterToken);
        // The name isn't needed any more; reloads and reconnects only resume from the stored token.
        history.replaceState(null, '', '/vote.html?pin=' + encodeURIComponent(pin));
        name = '';
      } else if (res.transport) {
        showError(res.error, {
          retry: true,
          onRetry: function () {
            QV.clear(view);
            view.appendChild(el('div', { class: 'card center' }, 'Connecting…'));
            join(); // same joinKey, so a join that did reach the server isn't duplicated
          },
        });
      } else {
        showError(res.error || 'Could not join this poll.');
      }
    });
  }

  /* ---- rendering ---- */

  function modeOf(s) {
    if (s.status === 'removed') return 'removed';
    if (s.status === 'rejected') return 'rejected';
    if (s.hasVoted) return 'voted';
    if (s.closed) return 'closed';
    if (s.status === 'pending') return 'pending';
    if (s.paused) return 'paused';
    return 'ballot';
  }

  // Changes whenever the host edits what the ballot looks like, so a stale form gets rebuilt.
  function ballotSig(s) {
    return JSON.stringify([
      s.multi,
      s.maxChoices,
      s.options.map(function (o) {
        return o.text;
      }),
    ]);
  }

  function render(s) {
    var final = s.status === 'rejected' || s.status === 'removed';
    if (final) QV.clearVoterToken(pin);
    var mode = modeOf(s);
    var sig = mode === 'ballot' ? ballotSig(s) : null;
    var cleared = mode === 'ballot' && current.mode === 'voted';
    var rebuilt = mode === 'ballot' && current.mode === 'ballot' && current.sig !== sig;
    var notice = cleared ? CHANGED_NOTICE : rebuilt ? OPTIONS_CHANGED_NOTICE : null;
    if (current.mode !== mode || notice) {
      QV.clear(view);
      current = { mode: mode, sig: sig, update: builders[mode](s, { notice: notice }) };
      document.title = s.title + ' - Quick Vote';
      srStatus.textContent = notice || ANNOUNCE[mode];
    }
    current.update(s);
    // Declined or removed is final: no resume, no re-join on reconnect.
    if (final) fatal = true;
  }

  function showError(message, opts) {
    var retry = opts && opts.retry;
    var onRetry = opts && opts.onRetry;
    fatal = !retry;
    QV.clear(view);
    current = { mode: 'error', update: null };
    view.appendChild(
      el(
        'div',
        { class: 'card center' },
        el('h1', null, retry ? 'Connection problem' : "Couldn't join"),
        el('p', { class: 'muted', text: message }),
        retry
          ? el(
              'button',
              {
                type: 'button',
                class: 'btn btn-primary',
                onclick:
                  onRetry ||
                  function () {
                    location.reload();
                  },
              },
              onRetry ? 'Retry' : 'Try again'
            )
          : el('a', { class: 'btn btn-primary', href: '/?pin=' + encodeURIComponent(pin) }, 'Back')
      )
    );
    srStatus.textContent = message;
  }

  var builders = {
    pending: function () {
      var titleEl = el('p', { class: 'poll-title' });
      var nameEl = el('strong');
      view.appendChild(
        el(
          'div',
          { class: 'card center' },
          el('div', { class: 'wait-bars', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
          titleEl,
          el('h1', null, 'Waiting for the host to let you in…'),
          el('p', { class: 'muted' }, 'You joined as ', nameEl),
          el('p', { class: 'muted small' }, 'Keep this page open. It will update by itself.')
        )
      );
      return function (s) {
        titleEl.textContent = s.title;
        nameEl.textContent = s.name;
      };
    },

    rejected: function () {
      view.appendChild(
        el(
          'div',
          { class: 'card center' },
          el('h1', null, 'Your request was declined'),
          el('p', { class: 'muted' }, 'The host did not let you into this poll.'),
          el('a', { class: 'btn btn-primary', href: '/' }, 'Back to home')
        )
      );
      return function () {};
    },

    removed: function () {
      view.appendChild(
        el(
          'div',
          { class: 'card center' },
          el('h1', null, 'You were removed from this poll'),
          el('p', { class: 'muted' }, 'The host took you out of this poll.'),
          el('a', { class: 'btn btn-primary', href: '/' }, 'Back to home')
        )
      );
      return function () {};
    },

    closed: function () {
      var titleEl = el('p', { class: 'poll-title' });
      view.appendChild(
        el(
          'div',
          { class: 'card center' },
          titleEl,
          el('h1', null, 'This poll is closed'),
          el('p', { class: 'muted' }, 'It is no longer taking votes.'),
          el('a', { class: 'btn btn-primary', href: '/' }, 'Back to home')
        )
      );
      return function (s) {
        titleEl.textContent = s.title;
      };
    },

    paused: function () {
      var titleEl = el('p', { class: 'poll-title' });
      view.appendChild(
        el(
          'div',
          { class: 'card center' },
          titleEl,
          el('h1', null, 'Voting is paused'),
          el('p', { class: 'muted' }, 'The host has paused voting. This page will update when it reopens.')
        )
      );
      return function (s) {
        titleEl.textContent = s.title;
      };
    },

    ballot: function (s, opts) {
      var titleEl = el('h1', { class: 'poll-title' });
      var limited = s.multi && s.maxChoices && s.maxChoices < s.options.length;
      var labels = [];
      var errorBox = el('p', { class: 'error', role: 'alert', hidden: true });
      var submit = el('button', { type: 'submit', class: 'btn btn-primary btn-block', disabled: true }, 'Submit vote');
      var type = s.multi ? 'checkbox' : 'radio';
      var inputs = [];

      var fieldset = el('fieldset', { class: 'choices' }, el('legend', { class: 'sr-only' }, limited ? 'Choose up to ' + s.maxChoices + ' options' : s.multi ? 'Choose one or more options' : 'Choose one option'));
      s.options.forEach(function (o) {
        var input = el('input', { type: type, name: 'choice', id: 'opt-' + o.id, value: String(o.id) });
        inputs.push(input);
        var label = el('label', { class: 'choice', for: 'opt-' + o.id }, input, el('span', { class: 'choice-text', text: o.text }));
        labels.push(label);
        fieldset.appendChild(label);
      });

      // Once the limit is reached the unchecked boxes lock, so the voter can't pick one too many.
      function applyLimit() {
        if (!s.multi || !s.maxChoices) return;
        var full = picked().length >= s.maxChoices;
        inputs.forEach(function (input, idx) {
          var lock = full && !input.checked;
          input.disabled = lock;
          if (lock) labels[idx].setAttribute('aria-disabled', 'true');
          else labels[idx].removeAttribute('aria-disabled');
        });
      }

      function picked() {
        return inputs
          .filter(function (i) {
            return i.checked;
          })
          .map(function (i) {
            return Number(i.value);
          });
      }

      var footText = limited ? 'Mark a cross in up to ' + s.maxChoices + ' boxes.' : s.multi ? 'Mark a cross in each box you choose.' : 'Mark one box with a cross.';
      var revision = s.revision;
      var form = el('form', { class: 'card ballot', novalidate: '' }, el('p', { class: 'paper-label' }, el('span', { lang: 'ms' }, 'Kertas undi'), ' · Ballot paper'), titleEl, el('p', { class: 'ballot-foot' }, footText), fieldset, errorBox, submit);
      if (opts && opts.notice) {
        form.insertBefore(el('div', { class: 'notice notice-warn' }, el('p', null, opts.notice)), form.firstChild);
      }

      form.addEventListener('change', function () {
        applyLimit();
        submit.disabled = picked().length === 0;
        errorBox.hidden = true;
      });

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var choices = picked();
        if (choices.length === 0 || (!s.multi && choices.length !== 1) || (s.multi && s.maxChoices && choices.length > s.maxChoices)) return;
        submit.disabled = true;
        submit.textContent = 'Submitting…';
        QV.emitAck(socket, 'voter:vote', { choices: choices, revision: revision }).then(function (res) {
          if (res.ok) return; // the voter:state that follows swaps this view for "Vote recorded"
          errorBox.textContent = res.error || 'Could not record your vote.';
          errorBox.hidden = false;
          submit.textContent = 'Submit vote';
          submit.disabled = picked().length === 0;
        });
      });

      view.appendChild(form);
      // Later states leave the form alone so a half-made selection isn't wiped when other people vote.
      return function (next) {
        titleEl.textContent = next.title;
        // A change that leaves the ballot looking the same (same options) still bumps the revision;
        // follow it so the voter isn't stuck on a stale-revision error they can't see the cause of.
        revision = next.revision;
      };
    },

    voted: function () {
      var titleEl = el('p', { class: 'poll-title' });
      var closedNote = el('p', { class: 'muted', hidden: true }, 'This poll is now closed.');
      var resultsBox = el('div');
      var resultsCard = el('div', { class: 'card', hidden: true }, el('h2', null, 'Live results'), resultsBox);

      view.appendChild(
        el(
          'div',
          null,
          el('div', { class: 'card center' }, el('div', { class: 'big-check', 'aria-hidden': 'true' }, QV.svgIcon('check')), el('h1', null, 'Vote recorded'), titleEl, closedNote),
          resultsCard
        )
      );

      return function (s) {
        titleEl.textContent = s.title;
        closedNote.hidden = !s.closed;
        if (s.results) {
          QV.renderResults(resultsBox, s.options, s.results, { mine: s.myChoices || [] });
          resultsCard.hidden = false;
        } else {
          // Live was switched off: remove the numbers entirely, not just visually.
          QV.clearResults(resultsBox);
          resultsCard.hidden = true;
        }
      };
    },
  };
})();
