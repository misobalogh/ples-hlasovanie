// Organizer results page logic.
(function () {
  'use strict';

  var cfg = window.PLES_CONFIG;
  var REFRESH_MS = 10000;
  var VIEWS = ['loading', 'login', 'denied', 'error', 'dashboard'];

  var client = null;
  var timer = null;
  var loading = false;
  var toggling = false;
  var acting = false;
  var votingOpen = null;
  var currentEmail = '';

  function $(id) { return document.getElementById(id); }

  // UI texts live in the HTML (#i18n), so this file stays English/ASCII.
  function t(key) {
    var el = document.querySelector('#i18n [data-msg="' + key + '"]');
    return el ? el.textContent : key;
  }

  function show(name) {
    VIEWS.forEach(function (v) { $('view-' + v).hidden = v !== name; });
  }

  function showError(text) {
    stopTimer();
    $('error-text').textContent = text || t('results-error');
    show('error');
  }

  function setNotice(text) {
    var el = $('dash-notice');
    el.textContent = text || '';
    el.hidden = !text;
  }

  function startTimer() {
    stopTimer();
    timer = window.setInterval(function () {
      if (!document.hidden) { loadResults(false); }
    }, REFRESH_MS);
  }

  function stopTimer() {
    if (timer) { window.clearInterval(timer); timer = null; }
  }

  function formatTime(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ---------- name helpers ----------

  var CATEGORIES = ['dievca', 'chlapec'];
  var KEY_DISMISSED = cfg.STORAGE_PREFIX + ':dismissed-suggestions';
  var MAX_SUGGESTIONS = 12;

  function hasDiacritics(text) { return text.normalize('NFD') !== text; }

  // Pick the nicest spelling of a group: most votes first, then one with
  // diacritics, then one that is not ALL CAPS / all lowercase.
  function displayName(group) {
    var own = group.variants.filter(function (v) { return v.key === group.key; });
    var pool = own.length ? own : group.variants;
    var best = pool.slice().sort(function (a, b) {
      if (b.count !== a.count) { return b.count - a.count; }
      var da = hasDiacritics(a.text) ? 1 : 0;
      var db = hasDiacritics(b.text) ? 1 : 0;
      if (db !== da) { return db - da; }
      var ma = a.text !== a.text.toLowerCase() && a.text !== a.text.toUpperCase() ? 1 : 0;
      var mb = b.text !== b.text.toLowerCase() && b.text !== b.text.toUpperCase() ? 1 : 0;
      return mb - ma;
    })[0];
    return prettify(best ? best.text : group.key);
  }

  // "lucia NOVAKOVA" -> "Lucia Novakova" (per word; mixed-case words are kept).
  function prettify(text) {
    return text.split(' ').map(function (w) {
      if (w === w.toLowerCase() || w === w.toUpperCase()) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }
      return w;
    }).join(' ');
  }

  function levenshtein(a, b) {
    var prev = [];
    var i, j;
    for (j = 0; j <= b.length; j++) { prev.push(j); }
    for (i = 1; i <= a.length; i++) {
      var cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // Typos and Slovak case endings: "luciu"~"lucia", "novakovu"~"novakova",
  // "nowakova"~"novakova", "tomasa"~"tomas".
  function similarWord(a, b) {
    if (a === b) { return true; }
    var longest = Math.max(a.length, b.length);
    if (levenshtein(a, b) <= (longest >= 6 ? 2 : 1)) { return true; }
    var p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) { p++; }
    return p >= 4 && p >= Math.min(a.length, b.length) - 2;
  }

  function similarKey(ka, kb) {
    var ta = ka.split(' ');
    var tb = kb.split(' ');
    if (ta.length !== tb.length) { return false; }
    var used = [];
    return ta.every(function (w) {
      for (var i = 0; i < tb.length; i++) {
        if (!used[i] && similarWord(w, tb[i])) { used[i] = true; return true; }
      }
      return false;
    });
  }

  function loadDismissed() {
    try { return JSON.parse(window.localStorage.getItem(KEY_DISMISSED) || '[]'); } catch (e) { return []; }
  }

  function pairId(category, k1, k2) { return [category].concat([k1, k2].sort()).join('|'); }

  function dismissPair(id) {
    var list = loadDismissed();
    if (list.indexOf(id) === -1) { list.push(id); }
    try { window.localStorage.setItem(KEY_DISMISSED, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  function findSuggestions(category, groups) {
    var dismissed = loadDismissed();
    var out = [];
    for (var i = 0; i < groups.length; i++) {
      for (var j = i + 1; j < groups.length; j++) {
        var a = groups[i];
        var b = groups[j];
        if (!similarKey(a.key, b.key)) { continue; }
        var id = pairId(category, a.key, b.key);
        if (dismissed.indexOf(id) !== -1) { continue; }
        // Merge the smaller group into the bigger one (groups are sorted by votes).
        out.push({ id: id, into: a, from: b });
      }
    }
    return out.slice(0, MAX_SUGGESTIONS);
  }

  // ---------- rendering ----------

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) { e.className = className; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }

  function smallButton(text, onClick, extraClass) {
    var b = el('button', 'link-btn' + (extraClass ? ' ' + extraClass : ''), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function renderSuggestions(box, category, groups) {
    box.replaceChildren();
    var list = findSuggestions(category, groups);
    box.hidden = !list.length;
    if (!list.length) { return; }

    box.appendChild(el('p', 'sugg-title', t('sugg-title')));
    list.forEach(function (s) {
      var row = el('div', 'sugg');
      var names = el('span', 'sugg-names');
      names.appendChild(el('strong', '', displayName(s.into)));
      names.appendChild(document.createTextNode(' (' + s.into.votes + ')  +  '));
      names.appendChild(el('strong', '', displayName(s.from)));
      names.appendChild(document.createTextNode(' (' + s.from.votes + ')'));
      row.appendChild(names);
      var actions = el('span', 'sugg-actions');
      actions.appendChild(smallButton(t('merge'), function () {
        runAction('merge_names', { p_category: category, p_from_key: s.from.key, p_to_key: s.into.key });
      }, 'is-primary'));
      actions.appendChild(smallButton(t('not-same'), function () {
        dismissPair(s.id);
        renderLast();
      }));
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  function renderItem(group, rank, max, category, others) {
    var li = el('li', 'result-item');
    if (rank && rank <= 3) { li.classList.add('top-' + rank); }

    li.appendChild(el('span', 'rank', rank ? rank + '.' : '-'));
    li.appendChild(el('span', 'rname', displayName(group)));
    var cnt = el('span', 'count', String(group.votes));
    cnt.setAttribute('aria-label', group.votes + ' ' + t('votes-label'));
    li.appendChild(cnt);

    var bar = el('div', 'bar');
    bar.setAttribute('aria-hidden', 'true');
    var fill = el('span');
    fill.style.width = (max > 0 ? Math.round((group.votes / max) * 100) : 0) + '%';
    bar.appendChild(fill);
    li.appendChild(bar);

    var meta = el('div', 'meta');

    if (group.variants.length > 1) {
      var vars = el('div', 'variants');
      vars.appendChild(el('span', 'variants-label', t('written-as') + ' '));
      group.variants.forEach(function (v, i) {
        var chip = el('span', 'variant', v.text + ' (' + v.count + ')');
        if (v.key !== group.key) {
          // This spelling was merged in by hand: allow splitting it out again.
          chip.appendChild(smallButton(t('unmerge'), function () {
            runAction('unmerge_name', { p_category: category, p_key: v.key });
          }, 'unmerge'));
        }
        vars.appendChild(chip);
        if (i < group.variants.length - 1) { vars.appendChild(document.createTextNode(' ')); }
      });
      meta.appendChild(vars);
    }

    var actions = el('div', 'item-actions');
    if (group.hidden) {
      actions.appendChild(smallButton(t('unhide'), function () {
        runAction('set_name_hidden', { p_category: category, p_key: group.key, p_hidden: false });
      }));
    } else {
      if (others.length) {
        var sel = el('select', 'merge-select');
        sel.setAttribute('aria-label', t('merge-with') + ' ' + displayName(group));
        var first = el('option', '', t('merge-with'));
        first.value = '';
        sel.appendChild(first);
        others.forEach(function (o) {
          var opt = el('option', '', displayName(o) + ' (' + o.votes + ')');
          opt.value = o.key;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', function () {
          var target = others.filter(function (o) { return o.key === sel.value; })[0];
          sel.value = '';
          sel.blur();
          if (!target) { return; }
          var q = t('confirm-merge').replace('{a}', displayName(group)).replace('{b}', displayName(target));
          if (!window.confirm(q)) { return; }
          runAction('merge_names', { p_category: category, p_from_key: group.key, p_to_key: target.key });
        });
        actions.appendChild(sel);
      }
      actions.appendChild(smallButton(t('hide'), function () {
        var q = t('confirm-hide').replace('{a}', displayName(group));
        if (!window.confirm(q)) { return; }
        runAction('set_name_hidden', { p_category: category, p_key: group.key, p_hidden: true });
      }));
    }
    meta.appendChild(actions);
    li.appendChild(meta);
    return li;
  }

  function renderCategory(category, groups) {
    var visible = groups.filter(function (g) { return !g.hidden; });
    var hidden = groups.filter(function (g) { return g.hidden; });

    renderSuggestions($('sugg-' + category), category, visible);

    var listEl = $('results-' + category);
    listEl.replaceChildren();
    if (!visible.length) {
      listEl.appendChild(el('li', 'empty-note', t('no-names')));
    }
    var max = visible.reduce(function (m, x) { return Math.max(m, x.votes); }, 0);
    var rank = 0;
    var prevVotes = null;
    visible.forEach(function (g, i) {
      // Competition ranking: ties share the same place (1., 1., 3.).
      if (g.votes !== prevVotes) { rank = i + 1; prevVotes = g.votes; }
      var others = visible.filter(function (o) { return o !== g; });
      listEl.appendChild(renderItem(g, rank, max, category, others));
    });

    var box = $('hidden-' + category);
    box.hidden = !hidden.length;
    $('hidden-count-' + category).textContent = String(hidden.length);
    var hiddenList = $('hidden-list-' + category);
    hiddenList.replaceChildren();
    hidden.forEach(function (g) {
      hiddenList.appendChild(renderItem(g, null, max, category, []));
    });
  }

  var lastData = null;

  function renderLast() { if (lastData) { render(lastData); } }

  // Run an organizer RPC (merge / unmerge / hide), then reload the results.
  function runAction(fn, args) {
    if (acting) { return; }
    acting = true;
    document.body.classList.add('is-busy');
    client.rpc(fn, args)
      .then(function (res) {
        if (res.error) {
          if (res.error.message === 'not_admin') {
            stopTimer();
            $('denied-email').textContent = currentEmail;
            show('denied');
            return;
          }
          throw res.error;
        }
        setNotice('');
      })
      .catch(function (err) {
        console.error(err);
        setNotice(t('action-failed'));
      })
      .then(function () {
        acting = false;
        document.body.classList.remove('is-busy');
        loadResults(false, true);
      });
  }

  function renderVotingState(open) {
    votingOpen = open;
    var state = $('voting-state');
    state.textContent = open ? t('state-open') : t('state-closed');
    state.classList.toggle('status-open', open);
    state.classList.toggle('status-closed', !open);

    var btn = $('btn-toggle');
    btn.textContent = open ? t('btn-close') : t('btn-open');
    btn.classList.toggle('btn-primary', !open);
    btn.disabled = toggling;
  }

  function render(data) {
    lastData = data;
    var names = Array.isArray(data.names) ? data.names : [];
    $('total-voters').textContent = String(data.total_voters || 0);
    renderVotingState(!!data.voting_open);
    CATEGORIES.forEach(function (c) {
      renderCategory(c, names.filter(function (x) { return x.category === c; }));
    });
    $('updated-at').textContent = t('updated-prefix') + ' ' + formatTime(new Date()) +
      ' - ' + t('updated-suffix');
  }

  // ---------- data ----------

  function loadResults(firstLoad, force) {
    if (loading || acting) { return; }
    // Do not rebuild the list under an open "merge with" dropdown.
    var active = document.activeElement;
    if (!firstLoad && !force && active && active.tagName === 'SELECT') { return; }
    loading = true;
    var refreshBtn = $('btn-refresh');
    refreshBtn.disabled = true;

    client.rpc('get_results')
      .then(function (res) {
        if (res.error) {
          if (res.error.message === 'not_admin') {
            stopTimer();
            $('denied-email').textContent = currentEmail;
            show('denied');
            return;
          }
          throw res.error;
        }
        render(res.data || {});
        setNotice('');
        if (firstLoad) {
          show('dashboard');
          startTimer();
        }
      })
      .catch(function (err) {
        console.error(err);
        if (firstLoad) {
          showError(t('results-load-error'));
        } else {
          setNotice(t('refresh-failed'));
        }
      })
      .then(function () {
        loading = false;
        refreshBtn.disabled = false;
      });
  }

  function enterWithSession(session) {
    currentEmail = (session && session.user && session.user.email) || '';
    $('user-email').textContent = currentEmail;
    show('loading');
    loadResults(true);
  }

  function toggleVoting() {
    if (toggling || votingOpen === null) { return; }
    var next = !votingOpen;
    var question = next
      ? t('confirm-open')
      : t('confirm-close');
    if (!window.confirm(question)) { return; }

    toggling = true;
    $('btn-toggle').disabled = true;

    client.rpc('set_voting_open', { p_open: next })
      .then(function (res) {
        if (res.error) {
          if (res.error.message === 'not_admin') {
            stopTimer();
            $('denied-email').textContent = currentEmail;
            show('denied');
            return;
          }
          throw res.error;
        }
        renderVotingState(res.data === true);
        setNotice('');
      })
      .catch(function (err) {
        console.error(err);
        setNotice(t('toggle-failed'));
      })
      .then(function () {
        toggling = false;
        $('btn-toggle').disabled = false;
        loadResults(false);
      });
  }

  function login(ev) {
    ev.preventDefault();
    var btn = $('btn-login');
    if (btn.disabled) { return; }

    var email = cfg.ADMIN_EMAIL;
    var password = $('password').value;
    var errEl = $('login-error');
    errEl.hidden = true;

    if (!password) {
      errEl.textContent = t('login-empty');
      errEl.hidden = false;
      return;
    }

    btn.disabled = true;
    btn.textContent = t('logging-in');

    client.auth.signInWithPassword({ email: email, password: password })
      .then(function (res) {
        if (res.error) {
          var invalid = res.error.status === 400 || /invalid/i.test(res.error.message || '');
          errEl.textContent = invalid
            ? t('login-invalid')
            : t('login-failed');
          errEl.hidden = false;
          return;
        }
        $('password').value = '';
        enterWithSession(res.data.session);
      })
      .catch(function (err) {
        console.error(err);
        errEl.textContent = t('login-failed');
        errEl.hidden = false;
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = t('login-button');
      });
  }

  function logout() {
    stopTimer();
    show('loading');
    client.auth.signOut()
      .catch(function (err) { console.error(err); })
      .then(function () {
        votingOpen = null;
        currentEmail = '';
        show('login');
      });
  }

  // ---------- init ----------

  document.querySelectorAll('[data-event-title]').forEach(function (el) {
    el.textContent = cfg.EVENT_TITLE;
  });

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    $('error-text').textContent = t('app-load-error');
    show('error');
    $('btn-retry').addEventListener('click', function () { window.location.reload(); });
    return;
  }

  client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: cfg.STORAGE_PREFIX + ':admin-auth',
    },
  });

  $('email').value = cfg.ADMIN_EMAIL;
  $('login-form').addEventListener('submit', login);
  $('btn-refresh').addEventListener('click', function () { loadResults(false); });
  $('btn-toggle').addEventListener('click', toggleVoting);
  $('btn-retry').addEventListener('click', function () {
    show('loading');
    loadResults(true);
  });
  document.querySelectorAll('[data-logout]').forEach(function (b) {
    b.addEventListener('click', logout);
  });

  client.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT') {
      // Defer: calling Supabase from inside this callback can deadlock.
      window.setTimeout(function () {
        stopTimer();
        show('login');
      }, 0);
    }
  });

  client.auth.getSession()
    .then(function (res) {
      if (res.data && res.data.session) {
        enterWithSession(res.data.session);
      } else {
        show('login');
      }
    })
    .catch(function () { show('login'); });
})();
