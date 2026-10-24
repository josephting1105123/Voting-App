(function () {
  'use strict';

  var QV = window.QV;
  var $ = QV.$;
  var MIN_OPTIONS = 2;
  var MAX_OPTIONS = 20;

  var form = $('create-form');
  var titleInput = $('title');
  var list = $('options');
  var addBtn = $('add-option');
  var errorBox = $('create-error');
  var submitBtn = $('create-btn');
  var anonRow = $('anon-row');
  var anonSwitch = $('anon-switch');
  var anonymous = false;
  var maxSlide = $('max-slide');
  var maxDown = $('max-down');
  var maxUp = $('max-up');
  var maxValue = $('max-value');
  var maxWanted = 2;
  var maxTouched = false;

  var OFFLINE_MESSAGE = "You're offline — reconnect and reload.";
  var editMatch = /^#edit=([0-9a-f]{48})$/.exec(location.hash);
  var editToken = editMatch ? editMatch[1] : null;
  var editMode = !!editToken;
  var socket = null;
  var prefilled = false;
  var submitLabel = 'Create poll';

  function showError(message, field) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    if (field) field.focus();
  }

  function rows() {
    return Array.prototype.slice.call(list.children);
  }

  function isMulti() {
    return form.querySelector('input[name="mode"]:checked').value === 'multi';
  }

  // Number of filled-in options, never below 2 so the stepper always has a range.
  function optionCount() {
    var count = rows().filter(function (row) {
      return row.querySelector('input').value.trim().length > 0;
    }).length;
    return Math.max(2, count);
  }

  // The value on display. maxWanted is the host's own choice and is never lowered by clamping,
  // so removing then re-adding options brings it back.
  function shownMax() {
    var upper = optionCount();
    return Math.max(2, Math.min(maxTouched ? maxWanted : upper, upper));
  }

  function renderMax() {
    var upper = optionCount();
    var shown = shownMax();
    maxValue.textContent = shown + ' of ' + upper;
    maxDown.disabled = shown <= 2;
    maxUp.disabled = shown >= upper;
  }

  function updateSlide() {
    var multi = isMulti();
    maxSlide.classList.toggle('open', multi);
    maxSlide.setAttribute('aria-hidden', multi ? 'false' : 'true');
    maxDown.tabIndex = multi ? 0 : -1;
    maxUp.tabIndex = multi ? 0 : -1;
  }

  // Keep numbering, labels and the min/max button states in sync after any add/remove.
  function refresh() {
    var all = rows();
    all.forEach(function (row, i) {
      var n = i + 1;
      var input = row.querySelector('input');
      var remove = row.querySelector('button');
      input.placeholder = 'Option ' + n;
      input.setAttribute('aria-label', 'Option ' + n);
      remove.setAttribute('aria-label', 'Remove option ' + n);
      remove.disabled = all.length <= MIN_OPTIONS;
    });
    addBtn.hidden = all.length >= MAX_OPTIONS;
    renderMax();
  }

  function addOption(focus, text) {
    if (rows().length >= MAX_OPTIONS) return;
    var input = QV.el('input', { type: 'text', maxlength: '100', autocomplete: 'off' });
    var remove = QV.el('button', { type: 'button', class: 'btn btn-secondary btn-icon' }, QV.svgIcon('x'));
    var row = QV.el('li', { class: 'option-row' }, input, remove);
    if (text) input.value = text;

    remove.addEventListener('click', function () {
      if (rows().length <= MIN_OPTIONS) return;
      var next = row.nextElementSibling || row.previousElementSibling;
      list.removeChild(row);
      refresh();
      if (next) next.querySelector('input').focus();
    });

    // Enter in the last option adds another one instead of submitting.
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (row === list.lastElementChild) addOption(true);
      else row.nextElementSibling.querySelector('input').focus();
    });

    list.appendChild(row);
    refresh();
    if (focus) input.focus();
  }

  function setAnonymous(value) {
    anonymous = value;
    anonSwitch.setAttribute('aria-checked', anonymous ? 'true' : 'false');
  }

  addOption(false);
  addOption(false);
  updateSlide();
  addBtn.addEventListener('click', function () {
    addOption(true);
  });
  list.addEventListener('input', renderMax);

  form.addEventListener('change', function (e) {
    if (e.target && e.target.name === 'mode') updateSlide();
  });
  maxDown.addEventListener('click', function () {
    maxWanted = shownMax() - 1;
    maxTouched = true;
    renderMax();
  });
  maxUp.addEventListener('click', function () {
    maxWanted = shownMax() + 1;
    maxTouched = true;
    renderMax();
  });

  // One handler on the whole row: the button's own click bubbles up here too.
  anonRow.addEventListener('click', function () {
    if (editMode) return;
    setAnonymous(!anonymous);
  });

  function prefill(state) {
    if (prefilled) return;
    prefilled = true;
    titleInput.value = state.title || '';
    while (list.firstChild) list.removeChild(list.firstChild);
    (state.options || []).forEach(function (o) {
      addOption(false, o.text);
    });
    while (rows().length < MIN_OPTIONS) addOption(false);
    var multi = !!state.multi;
    form.querySelector('input[name="mode"][value="' + (multi ? 'multi' : 'single') + '"]').checked = true;
    updateSlide();
    if (multi) {
      maxWanted = state.maxChoices;
      // An "any number" poll (limit = every option) stays that way when options are added.
      maxTouched = state.maxChoices < (state.options || []).length;
    }
    renderMax();
    setAnonymous(!!state.anonymous);
  }

  if (editMode) {
    document.title = 'Edit poll - Quick Vote';
    $('page-heading').textContent = 'Edit poll';
    submitLabel = 'Save changes';
    submitBtn.textContent = submitLabel;
    $('edit-note').hidden = false;
    var cancel = $('edit-cancel');
    cancel.hidden = false;
    cancel.href = '/admin.html#' + editToken;
    // Cancel resumes voting (the poll was paused to get here), then goes back whatever the result.
    cancel.addEventListener('click', function (e) {
      e.preventDefault();
      var back = function () {
        location.href = '/admin.html#' + editToken;
      };
      if (!socket || cancel.getAttribute('aria-disabled') === 'true') return back();
      cancel.setAttribute('aria-disabled', 'true');
      QV.emitAck(socket, 'admin:setPaused', { paused: false }).then(back, back);
    });
    $('keep-open-note').hidden = true;
    QV.keepAlive();
    anonRow.classList.add('is-locked');
    anonSwitch.setAttribute('aria-disabled', 'true');
    $('anon-help').textContent = "This can't be changed after the poll is created.";
    submitBtn.disabled = true;

    if (typeof io === 'undefined') {
      showError(OFFLINE_MESSAGE);
      addBtn.disabled = true;
    } else {
      socket = io();
      socket.on('connect', function () {
        // The server binds the admin token per socket, so authenticate again on every (re)connect.
        QV.emitAck(socket, 'admin:auth', { token: editToken }).then(function (res) {
          if (res && res.transport) return; // reconnect will try again
          if (!res || !res.ok) {
            showError(res && res.error === 'not found' ? 'This poll has expired or no longer exists.' : (res && res.error) || 'Something went wrong. Please try again.');
            submitBtn.disabled = true;
            return;
          }
          if (res.state.closed) {
            showError("This poll is closed, so it can't be edited.");
            submitBtn.disabled = true;
            return;
          }
          if (prefilled) return; // keep the host's edits
          errorBox.hidden = true;
          prefill(res.state);
          submitBtn.disabled = false;
        });
      });
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox.hidden = true;

    var title = titleInput.value.trim();
    if (!title) return showError('Give your poll a title.', titleInput);

    var options = rows()
      .map(function (row) {
        return row.querySelector('input').value.trim();
      })
      .filter(function (text) {
        return text.length > 0;
      });
    if (options.length < MIN_OPTIONS) return showError('Add at least two options.', list.querySelector('input'));

    var multi = isMulti();
    var picks = multi ? Math.min(shownMax(), options.length) : undefined;

    if (editMode) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      QV.emitAck(socket, 'admin:edit', { title: title, options: options, multi: multi, maxChoices: picks }).then(function (res) {
        if (res && res.ok) {
          location.href = '/admin.html#' + editToken;
          return;
        }
        showError(res && res.transport ? OFFLINE_MESSAGE : (res && res.error) || 'Something went wrong. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
      });
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';

    fetch('/api/polls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, options: options, multi: multi, maxChoices: picks, anonymous: anonymous }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            return { ok: res.ok, body: body };
          });
      })
      .then(function (r) {
        if (!r.ok || !r.body.adminToken) {
          throw new Error(r.body.error || 'Something went wrong. Please try again.');
        }
        QV.saveAdminPoll({ pin: r.body.pin, title: title, adminToken: r.body.adminToken, createdAt: Date.now() });
        location.href = '/admin.html#' + r.body.adminToken;
      })
      .catch(function (err) {
        var offline = err instanceof TypeError; // fetch network failure
        showError(offline ? "Couldn't reach the server. Check your connection and try again." : err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
      });
  });
})();
