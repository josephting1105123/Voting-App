/* Quick Vote shared helpers. Exposes window.QV.
 * Rule for every page: user-supplied text only ever reaches the DOM through textContent / text nodes.
 * There is no innerHTML anywhere in this app. */
(function () {
  'use strict';

  var ADMIN_POLLS_KEY = 'qv:adminPolls';
  var VOTER_KEY_PREFIX = 'qv:voter:';
  var DAY_MS = 24 * 60 * 60 * 1000;
  var MAX_SAVED_POLLS = 30;

  function $(id) {
    return document.getElementById(id);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function appendChildren(parent, children) {
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child === null || child === undefined || child === false || child === true) continue;
      if (Array.isArray(child)) appendChildren(parent, child);
      else if (child instanceof Node) parent.appendChild(child);
      else parent.appendChild(document.createTextNode(String(child)));
    }
  }

  /* el('button', { class: 'btn', type: 'button', onclick: fn }, 'Label', childNode)
   * props: class, text, on<event> handlers, value/checked/disabled/hidden (as properties),
   * everything else becomes an attribute (pass aria-* values as strings, e.g. 'false').
   * Children: strings become text nodes, arrays are flattened, null/false are skipped. */
  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var val = props[key];
        if (val === undefined || val === null || val === false) return;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key.indexOf('on') === 0 && typeof val === 'function') node.addEventListener(key.slice(2).toLowerCase(), val);
        else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'hidden') node[key] = val;
        else node.setAttribute(key, val === true ? '' : String(val));
      });
    }
    appendChildren(node, Array.prototype.slice.call(arguments, 2));
    return node;
  }

  /* svgIcon('check' | 'x' | 'chevron-right'): fixed internal path table, built with createElementNS (no markup strings). */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICON_PATHS = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    x: 'M18 6 6 18M6 6l12 12',
    'chevron-right': 'm9 6 6 6-6 6',
  };

  function svgIcon(name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (Object.prototype.hasOwnProperty.call(ICON_PATHS, name)) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', ICON_PATHS[name]);
      svg.appendChild(path);
    }
    return svg;
  }

  /* ---- keyed list reconciliation: updates rows in place so buttons don't vanish under a tap ---- */

  function reconcile(container, items, key, create, update) {
    var prev = container._qvKeyed || new Map();
    var next = new Map();
    var cursor = container.firstChild;
    items.forEach(function (item) {
      var k = key(item);
      var node = prev.get(k);
      if (node) prev.delete(k);
      else node = create(item);
      update(node, item);
      next.set(k, node);
      if (node === cursor) cursor = cursor.nextSibling;
      else container.insertBefore(node, cursor);
    });
    prev.forEach(function (node) {
      if (node.parentNode === container) container.removeChild(node);
    });
    container._qvKeyed = next;
  }

  /* ---- results bars ----
   * options: [{ id, text }]   results: { options: [{ id, count }], totalVoted }
   * opts.mine: array of option ids to mark with a check.
   * Re-calling with the same options updates the bars in place, so widths animate. */

  function renderResults(container, options, results, opts) {
    var mine = new Set((opts && opts.mine) || []);
    var counts = new Map();
    (results.options || []).forEach(function (o) {
      counts.set(o.id, o.count);
    });
    var total = results.totalVoted || 0;

    var sig = options
      .map(function (o) {
        return o.id + ':' + o.text;
      })
      .join('\u0000');

    var rows = container._qvRows;
    if (!rows || container._qvSig !== sig) {
      clear(container);
      var list = el('ul', { class: 'results' });
      rows = new Map();
      options.forEach(function (o) {
        var mineTag = el('span', { class: 'result-mine' }, svgIcon('check'), el('span', { class: 'sr-only', text: 'your pick' }));
        var text = el('span', { class: 'result-text', text: o.text }, mineTag);
        var num = el('span', { class: 'result-num' });
        var fill = el('div', { class: 'bar-fill' });
        var row = el('li', { class: 'result' }, el('div', { class: 'result-head' }, text, num), el('div', { class: 'bar', 'aria-hidden': 'true' }, fill));
        rows.set(o.id, { row: row, num: num, fill: fill });
        list.appendChild(row);
      });
      container.appendChild(list);
      container._qvRows = rows;
      container._qvSig = sig;
      void list.offsetWidth; // flush so the first width change animates from 0
    }

    var max = 0;
    options.forEach(function (o) {
      var c = counts.get(o.id) || 0;
      if (c > max) max = c;
    });

    options.forEach(function (o) {
      var r = rows.get(o.id);
      var count = counts.get(o.id) || 0;
      var pct = total > 0 ? Math.round((count * 100) / total) : 0;
      r.num.textContent = total > 0 ? count + ' · ' + pct + '%' : String(count);
      r.fill.style.width = pct + '%';
      r.row.classList.toggle('mine', mine.has(o.id));
      r.row.classList.toggle('is-lead', max > 0 && count === max);
    });
  }

  function clearResults(container) {
    clear(container);
    container._qvRows = null;
    container._qvSig = null;
  }

  /* ---- clipboard ---- */

  function legacyCopy(text) {
    var previous = document.activeElement;
    var ta = el('textarea', { class: 'sr-copy', readonly: '', 'aria-hidden': 'true', tabindex: '-1' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      ta.setSelectionRange(0, text.length);
    } catch (e) {
      /* some browsers throw on hidden elements; select() above is enough */
    }
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    if (previous && typeof previous.focus === 'function') previous.focus();
    return ok;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return legacyCopy(text);
        }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  /* Briefly swap a button's label, e.g. "Copied". */
  function flash(button, text, ms) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = text;
    clearTimeout(button._qvTimer);
    button._qvTimer = setTimeout(function () {
      button.textContent = button.dataset.label;
    }, ms || 1500);
  }

  /* ---- localStorage (can throw in private mode, so everything is wrapped) ---- */

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Saved admin polls: [{ pin, title, adminToken, createdAt }], newest first, expired ones dropped. */
  function loadAdminPolls() {
    var all = readJSON(ADMIN_POLLS_KEY, []);
    if (!Array.isArray(all)) return [];
    var cutoff = Date.now() - DAY_MS;
    var kept = all.filter(function (p) {
      return p && typeof p.adminToken === 'string' && typeof p.pin === 'string' && typeof p.title === 'string' && Number(p.createdAt) > cutoff;
    });
    if (kept.length !== all.length) writeJSON(ADMIN_POLLS_KEY, kept);
    return kept;
  }

  function saveAdminPoll(entry) {
    var list = loadAdminPolls().filter(function (p) {
      return p.adminToken !== entry.adminToken;
    });
    list.unshift(entry);
    writeJSON(ADMIN_POLLS_KEY, list.slice(0, MAX_SAVED_POLLS));
  }

  function forgetAdminPoll(adminToken) {
    writeJSON(
      ADMIN_POLLS_KEY,
      loadAdminPolls().filter(function (p) {
        return p.adminToken !== adminToken;
      })
    );
  }

  function getVoterToken(pin) {
    try {
      return localStorage.getItem(VOTER_KEY_PREFIX + pin) || null;
    } catch (e) {
      return null;
    }
  }

  function setVoterToken(pin, token) {
    try {
      localStorage.setItem(VOTER_KEY_PREFIX + pin, token);
    } catch (e) {
      /* private mode: the vote still works, resume after reload won't */
    }
  }

  function clearVoterToken(pin) {
    try {
      localStorage.removeItem(VOTER_KEY_PREFIX + pin);
    } catch (e) {
      /* nothing to clear */
    }
  }

  /* ---- sockets ---- */

  /* Promise wrapper around an emit with an ack. Never rejects: resolves { ok:false, error } on timeout. */
  function emitAck(socket, event, payload, timeoutMs) {
    return new Promise(function (resolve) {
      socket.timeout(timeoutMs || 8000).emit(event, payload, function (err, res) {
        // transport: true means the request may or may not have reached the server (as opposed to being refused).
        if (err) resolve({ ok: false, transport: true, error: 'No response from the server. Check your connection.' });
        else resolve(res && typeof res === 'object' ? res : { ok: false, transport: true, error: 'Unexpected response from the server.' });
      });
    });
  }

  /* Render's free tier sleeps after ~15 minutes without traffic, which would wipe every poll.
   * An open admin or voter page pings /healthz every 4 minutes to keep the server awake. */
  function keepAlive() {
    setInterval(function () {
      try {
        fetch('/healthz', { cache: 'no-store' }).catch(function () {});
      } catch (e) {
        /* ignore */
      }
    }, 4 * 60 * 1000);
  }

  function watchConnection(socket, banner) {
    socket.on('connect', function () {
      banner.hidden = true;
    });
    socket.on('disconnect', function () {
      banner.hidden = false;
    });
    socket.on('connect_error', function () {
      banner.hidden = false;
    });
  }

  /* ---- home page (index.html has no script of its own) ---- */

  function initHome() {
    var form = $('join-form');
    if (!form) return;
    var pinInput = $('pin');
    var nameInput = $('name');
    var errorBox = $('join-error');
    var pinEntry = $('pin-entry');

    function syncPinCells() {
      if (!pinEntry) return;
      pinEntry.setAttribute('data-len', String(pinInput.value.length));
      var cells = pinEntry.querySelectorAll('.pin-cell');
      for (var i = 0; i < cells.length; i++) cells[i].textContent = pinInput.value.charAt(i);
    }

    function showError(message, field) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      if (field) field.focus();
    }

    var prefill = new URLSearchParams(location.search).get('pin');
    if (prefill && /^\d{1,6}$/.test(prefill)) {
      pinInput.value = prefill;
      nameInput.focus();
    }
    syncPinCells();

    // Keep the caret at the end so typing always fills the next cell.
    function caretToEnd() {
      var n = pinInput.value.length;
      try {
        pinInput.setSelectionRange(n, n);
      } catch (e) {
        /* ignore */
      }
    }
    pinInput.addEventListener('focus', caretToEnd);
    pinInput.addEventListener('click', caretToEnd);
    pinInput.addEventListener('keyup', caretToEnd);
    pinInput.addEventListener('select', caretToEnd);

    pinInput.addEventListener('input', function () {
      var digits = pinInput.value.replace(/\D/g, '').slice(0, 6);
      if (digits !== pinInput.value) pinInput.value = digits;
      syncPinCells();
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errorBox.hidden = true;
      var pin = pinInput.value.trim();
      var name = nameInput.value.trim();
      if (!/^\d{6}$/.test(pin)) return showError('Enter the 6-digit PIN.', pinInput);
      if (!name) return showError('Enter your name.', nameInput);
      if (Array.from(name).length > 40) return showError('Names can be up to 40 characters.', nameInput);
      location.href = '/vote.html?pin=' + encodeURIComponent(pin) + '&name=' + encodeURIComponent(name);
    });

    var polls = loadAdminPolls();
    if (polls.length > 0) {
      var list = $('my-polls-list');
      polls.forEach(function (p) {
        var go = svgIcon('chevron-right');
        go.setAttribute('class', 'poll-link-go');
        list.appendChild(
          el(
            'li',
            { class: 'list-item' },
            el('a', { class: 'poll-link', href: '/admin.html#' + encodeURIComponent(p.adminToken) }, el('span', { class: 'poll-link-title', text: p.title }), el('span', { class: 'poll-link-pin', text: 'PIN ' + p.pin }), go)
          )
        );
      });
      $('my-polls').hidden = false;
    }
  }

  window.QV = {
    $: $,
    el: el,
    svgIcon: svgIcon,
    clear: clear,
    reconcile: reconcile,
    renderResults: renderResults,
    clearResults: clearResults,
    copyToClipboard: copyToClipboard,
    flash: flash,
    loadAdminPolls: loadAdminPolls,
    saveAdminPoll: saveAdminPoll,
    forgetAdminPoll: forgetAdminPoll,
    getVoterToken: getVoterToken,
    setVoterToken: setVoterToken,
    clearVoterToken: clearVoterToken,
    emitAck: emitAck,
    keepAlive: keepAlive,
    watchConnection: watchConnection,
  };

  // Installable PWA: failures (private mode, unsupported browser) must never break the page.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      try {
        navigator.serviceWorker.register('/sw.js').catch(function () {});
      } catch (e) {
        /* ignore */
      }
    });
  }

  // Two-option sliding toggle (markup: .slider > .slider-thumb + two .slider-opt buttons).
  function bindSlider(root, onPick) {
    var opts = root.querySelectorAll('.slider-opt');
    var thumb = root.querySelector('.slider-thumb');
    if (opts.length !== 2 || !thumb) return null;
    var down = false;
    var dragging = false;
    var startX = 0;
    var swallowClick = false;

    function setIndex(i) {
      root.dataset.index = String(i);
      for (var k = 0; k < opts.length; k++) {
        opts[k].setAttribute('aria-checked', String(k === i));
        opts[k].setAttribute('tabindex', k === i ? '0' : '-1');
      }
    }

    function posFor(clientX) {
      var rect = root.getBoundingClientRect();
      var thumbW = thumb.offsetWidth;
      var span = rect.width - 8 - thumbW;
      if (span <= 0) return 0;
      var p = (clientX - rect.left - 4 - thumbW / 2) / span;
      return p < 0 ? 0 : p > 1 ? 1 : p;
    }

    function endDrag() {
      down = false;
      dragging = false;
      root.classList.remove('is-dragging');
      root.style.removeProperty('--pos');
    }

    Array.prototype.forEach.call(opts, function (opt, k) {
      opt.addEventListener('click', function () {
        if (swallowClick) {
          swallowClick = false;
          return;
        }
        onPick(k);
      });
    });

    root.addEventListener('keydown', function (e) {
      var k = -1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') k = 0;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') k = 1;
      if (k < 0) return;
      e.preventDefault();
      onPick(k);
      opts[k].focus();
    });

    root.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.isPrimary === false) return;
      down = true;
      dragging = false;
      startX = e.clientX;
    });

    root.addEventListener('pointermove', function (e) {
      if (!down) return;
      if (!dragging) {
        if (Math.abs(e.clientX - startX) <= 4) return;
        dragging = true;
        root.classList.add('is-dragging');
        try {
          root.setPointerCapture(e.pointerId);
        } catch (err) {
          /* ignore */
        }
      }
      root.style.setProperty('--pos', String(posFor(e.clientX)));
    });

    root.addEventListener('pointerup', function (e) {
      if (!down) return;
      var wasDragging = dragging;
      var p = posFor(e.clientX);
      endDrag();
      if (wasDragging) {
        swallowClick = true;
        setTimeout(function () {
          swallowClick = false;
        }, 0);
        onPick(p > 0.5 ? 1 : 0);
      }
    });

    root.addEventListener('pointercancel', endDrag);

    return { setIndex: setIndex };
  }

  function initSliders() {
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var ready = [];

    var roleRoot = document.getElementById('role-slider');
    if (roleRoot) {
      var initial = Number(roleRoot.dataset.index) || 0;
      var cur = initial;
      var roleOpts = roleRoot.querySelectorAll('.slider-opt');
      var roleSlider = bindSlider(roleRoot, function (i) {
        if (i === cur) return;
        cur = i;
        roleSlider.setIndex(i);
        var href = roleOpts[i].dataset.href;
        if (!href) return;
        setTimeout(function () {
          location.href = href;
        }, reduced ? 0 : 300);
      });
      if (roleSlider) {
        roleSlider.setIndex(cur);
        ready.push(roleRoot);
        // bfcache restores the page as we left it; put the slider back on this page's side
        window.addEventListener('pageshow', function (e) {
          if (e.persisted) {
            cur = initial;
            roleSlider.setIndex(initial);
          }
        });
      }
    }

    if (ready.length) {
      requestAnimationFrame(function () {
        for (var k = 0; k < ready.length; k++) ready[k].classList.add('is-ready');
      });
    }
  }

  function initThemeToggle() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    function current() {
      return (
        document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      );
    }
    function label() {
      btn.setAttribute('aria-label', 'Switch to ' + (current() === 'dark' ? 'light' : 'dark') + ' theme');
    }
    label();
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('qv-theme', next);
      } catch (e) {
        /* ignore */
      }
      label();
    });
  }

  function boot() {
    initThemeToggle();
    initSliders();
    if (document.body && document.body.getAttribute('data-page') === 'home') initHome();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
