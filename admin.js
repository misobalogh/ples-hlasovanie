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

  // ---------- rendering ----------

  function renderCategory(listEl, items) {
    listEl.replaceChildren();
    if (!items.length) {
      var empty = document.createElement('li');
      empty.className = 'empty-note';
      empty.textContent = t('no-candidates');
      listEl.appendChild(empty);
      return;
    }

    var max = items.reduce(function (m, x) { return Math.max(m, x.votes); }, 0);
    var rank = 0;
    var prevVotes = null;

    items.forEach(function (c, i) {
      // Competition ranking: ties share the same place (1., 1., 3.).
      if (c.votes !== prevVotes) { rank = i + 1; prevVotes = c.votes; }

      var li = document.createElement('li');
      li.className = 'result-item';
      if (c.votes > 0 && rank <= 3) { li.classList.add('top-' + rank); }
      if (c.active === false) { li.classList.add('inactive'); }

      var r = document.createElement('span');
      r.className = 'rank';
      r.textContent = rank + '.';

      var n = document.createElement('span');
      n.className = 'rname';
      n.textContent = c.name;
      if (c.active === false) {
        var tag = document.createElement('span');
        tag.className = 'inactive-tag';
        tag.textContent = ' ' + t('inactive');
        n.appendChild(tag);
      }

      var cnt = document.createElement('span');
      cnt.className = 'count';
      cnt.textContent = String(c.votes);
      cnt.setAttribute('aria-label', c.votes + ' ' + t('votes-label'));

      var bar = document.createElement('div');
      bar.className = 'bar';
      bar.setAttribute('aria-hidden', 'true');
      var fill = document.createElement('span');
      fill.style.width = (max > 0 ? Math.round((c.votes / max) * 100) : 0) + '%';
      bar.appendChild(fill);

      li.appendChild(r);
      li.appendChild(n);
      li.appendChild(cnt);
      li.appendChild(bar);
      listEl.appendChild(li);
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
    var list = Array.isArray(data.candidates) ? data.candidates : [];
    $('total-voters').textContent = String(data.total_voters || 0);
    renderVotingState(!!data.voting_open);
    renderCategory($('results-girls'), list.filter(function (x) { return x.category === 'dievca'; }));
    renderCategory($('results-boys'), list.filter(function (x) { return x.category === 'chlapec'; }));
    $('updated-at').textContent = t('updated-prefix') + ' ' + formatTime(new Date()) +
      ' - ' + t('updated-suffix');
  }

  // ---------- data ----------

  function loadResults(firstLoad) {
    if (loading) { return; }
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
