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

  function showError(message, field) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    if (field) field.focus();
  }

  function rows() {
    return Array.prototype.slice.call(list.children);
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
  }

  function addOption(focus) {
    if (rows().length >= MAX_OPTIONS) return;
    var input = QV.el('input', { type: 'text', maxlength: '100', autocomplete: 'off' });
    var remove = QV.el('button', { type: 'button', class: 'btn btn-secondary btn-icon' }, QV.svgIcon('x'));
    var row = QV.el('li', { class: 'option-row' }, input, remove);

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
  addBtn.addEventListener('click', function () {
    addOption(true);
  });

  // One handler on the whole row: the button's own click bubbles up here too.
  anonRow.addEventListener('click', function () {
    setAnonymous(!anonymous);
  });

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

    var multi = form.querySelector('input[name="mode"]:checked').value === 'multi';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';

    fetch('/api/polls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, options: options, multi: multi, anonymous: anonymous }),
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
        submitBtn.textContent = 'Create poll';
      });
  });
})();
