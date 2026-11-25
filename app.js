// Public voting page logic.
(function () {
  'use strict';

  var cfg = window.PLES_CONFIG;
  var KEY_DEVICE = cfg.STORAGE_PREFIX + ':device_id';
  var KEY_VOTED = cfg.STORAGE_PREFIX + ':voted';

  var VIEWS = ['loading', 'error', 'closed', 'already', 'thanks', 'form'];
  var TABS = ['girl', 'boy'];
  // Show the name search only when a category has more candidates than this.
  var SEARCH_MIN_CANDIDATES = 8;
  var AUTO_ADVANCE_MS = 350;

  var activeTab = 'girl';
  var advanceTimer = null;

  var client = null;
  var submitting = false;
  var memoryStore = {}; // fallback when localStorage is unavailable

  // ---------- helpers ----------

  function $(id) { return document.getElementById(id); }

  // UI texts live in the HTML (#i18n), so this file stays English/ASCII.
  function t(key) {
    var el = document.querySelector('#i18n [data-msg="' + key + '"]');
    return el ? el.textContent : key;
  }

  function show(name) {
    VIEWS.forEach(function (v) { $('view-' + v).hidden = v !== name; });
    window.scrollTo(0, 0);
  }

  function storeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return memoryStore[key] || null; }
  }

  function storeSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { memoryStore[key] = value; }
  }

  function uuidv4() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function getDeviceId() {
    var id = storeGet(KEY_DEVICE);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      id = uuidv4();
      storeSet(KEY_DEVICE, id);
    }
    return id;
  }

  function markVoted() { storeSet(KEY_VOTED, '1'); }
  function hasVoted() { return storeGet(KEY_VOTED) === '1'; }

  function showError(text) {
    $('error-text').textContent = text ||
      t('load-error');
    show('error');
  }

  // ---------- rendering ----------

  function renderList(container, groupName, items) {
    container.replaceChildren();
    if (!items.length) {
      var p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = t('no-candidates');
      container.appendChild(p);
      return;
    }
    items.forEach(function (c) {
      var label = document.createElement('label');
      label.className = 'card';
      label.setAttribute('data-search', normalize(c.name));

      var input = document.createElement('input');
      input.type = 'radio';
      input.name = groupName;
      input.value = String(c.id);

      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.name;

      label.appendChild(input);
      label.appendChild(dot);
      label.appendChild(name);
      container.appendChild(label);
    });
  }

  // Lowercase and strip diacritics, so "tomas" matches "Tomas" with accents.
  function normalize(text) {
    return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  function selectedInput(groupName) {
    return document.querySelector('input[name="' + groupName + '"]:checked');
  }

  function selectedName(groupName) {
    var input = selectedInput(groupName);
    if (!input) { return null; }
    var name = input.parentNode.querySelector('.name');
    return name ? name.textContent : null;
  }

  function listFor(tab) { return $(tab === 'girl' ? 'list-girls' : 'list-boys'); }

  function setTab(tab, focusTab) {
    if (advanceTimer) { window.clearTimeout(advanceTimer); advanceTimer = null; }
    var changed = tab !== activeTab;
    activeTab = tab;
    TABS.forEach(function (name) {
      var btn = $('tab-' + name);
      var on = name === tab;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      $('panel-' + name).hidden = !on;
    });
    if (focusTab) { $('tab-' + tab).focus(); }
    if (changed) {
      $('search').value = '';
      applySearch();
      // Bring the start of the list into view if the user scrolled down.
      var head = document.querySelector('.picker-head');
      if (head && head.getBoundingClientRect().top < 0) {
        head.scrollIntoView({ block: 'start' });
      }
    }
    updateSearchVisibility();
  }

  function updateSearchVisibility() {
    var count = listFor(activeTab).querySelectorAll('.card').length;
    var tooFew = count <= SEARCH_MIN_CANDIDATES;
    $('search-wrap').hidden = tooFew;
    if (tooFew && $('search').value) { $('search').value = ''; applySearch(); }
  }

  function applySearch() {
    var query = normalize($('search').value);
    var list = listFor(activeTab);
    var cards = list.querySelectorAll('.card');
    var visible = 0;
    Array.prototype.forEach.call(cards, function (card) {
      var match = !query || card.getAttribute('data-search').indexOf(query) !== -1;
      card.hidden = !match;
      if (match) { visible += 1; }
    });
    $('no-match').hidden = !(cards.length && visible === 0);
    $('search-clear').hidden = !query;
  }

  function selectedValue(groupName) {
    var el = document.querySelector('input[name="' + groupName + '"]:checked');
    return el ? Number(el.value) : null;
  }

  function updateSubmitState() {
    // Fallback highlight for browsers without :has()
    document.querySelectorAll('.card').forEach(function (card) {
      var input = card.querySelector('input');
      card.classList.toggle('is-checked', !!(input && input.checked));
    });

    var girl = selectedValue('girl');
    var boy = selectedValue('boy');
    var ready = girl !== null && boy !== null;
    $('btn-submit').disabled = !ready || submitting;

    var girlName = selectedName('girl');
    var boyName = selectedName('boy');
    $('tab-pick-girl').textContent = girlName || t('tab-girl-empty');
    $('tab-pick-boy').textContent = boyName || t('tab-boy-empty');
    $('tab-girl').classList.toggle('is-done', girl !== null);
    $('tab-boy').classList.toggle('is-done', boy !== null);
  }

  function setSubmitting(on) {
    submitting = on;
    var btn = $('btn-submit');
    btn.replaceChildren();
    if (on) {
      var sp = document.createElement('span');
      sp.className = 'spinner-inline';
      sp.setAttribute('aria-hidden', 'true');
      btn.appendChild(sp);
      btn.appendChild(document.createTextNode(t('submitting')));
    } else {
      btn.textContent = t('submit');
    }
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    updateSubmitState();
  }

  function setFormError(text) {
    var el = $('form-error');
    el.textContent = text || '';
    el.hidden = !text;
  }

  // ---------- data ----------

  function load() {
    if (hasVoted()) { show('already'); return; }
    if (!client) {
      showError(t('app-load-error'));
      return;
    }
    show('loading');

    var settingsReq = client.from('settings').select('voting_open').limit(1).maybeSingle();
    var candidatesReq = client
      .from('candidates')
      .select('id, name, category')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    Promise.all([settingsReq, candidatesReq])
      .then(function (res) {
        var s = res[0];
        var c = res[1];
        if (s.error || c.error) { throw s.error || c.error; }

        if (!s.data || !s.data.voting_open) { show('closed'); return; }

        var girls = c.data.filter(function (x) { return x.category === 'dievca'; });
        var boys = c.data.filter(function (x) { return x.category === 'chlapec'; });
        renderList($('list-girls'), 'girl', girls);
        renderList($('list-boys'), 'boy', boys);
        setFormError('');
        $('search').value = '';
        activeTab = null;
        setTab('girl');
        updateSubmitState();
        show('form');
      })
      .catch(function (err) {
        console.error(err);
        showError();
      });
  }

  function submit(ev) {
    ev.preventDefault();
    if (submitting) { return; } // guards against double tap / double click

    var girl = selectedValue('girl');
    var boy = selectedValue('boy');
    if (girl === null || boy === null) { updateSubmitState(); return; }

    setFormError('');
    setSubmitting(true);

    client
      .rpc('cast_vote', { p_device_id: getDeviceId(), p_girl_id: girl, p_boy_id: boy })
      .then(function (res) {
        if (!res.error) {
          markVoted();
          show('thanks');
          return;
        }
        var msg = res.error.message || '';
        if (msg === 'already_voted') {
          markVoted();
          show('already');
        } else if (msg === 'voting_closed') {
          show('closed');
        } else if (msg === 'invalid_girl' || msg === 'invalid_boy') {
          setFormError(t('candidates-changed'));
          window.setTimeout(load, 1500);
        } else {
          console.error(res.error);
          setFormError(t('submit-error'));
        }
      })
      .catch(function (err) {
        // Network failure. Retrying is safe: the same device_id is reused,
        // so a vote that did reach the server comes back as already_voted.
        console.error(err);
        setFormError(t('submit-error'));
      })
      .then(function () { setSubmitting(false); });
  }

  // ---------- init ----------

  document.querySelectorAll('[data-event-title]').forEach(function (el) {
    el.textContent = cfg.EVENT_TITLE;
  });
  document.title = t('page-title') + ' - ' + cfg.EVENT_TITLE;

  if (window.supabase && typeof window.supabase.createClient === 'function') {
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  getDeviceId(); // create the id on the first visit
  $('view-form').addEventListener('change', function (ev) {
    updateSubmitState();
    var target = ev.target;
    if (!target || target.type !== 'radio') { return; }
    // Auto-advance to the other category if it has no pick yet.
    var other = target.name === 'girl' ? 'boy' : 'girl';
    if (target.name === activeTab && selectedValue(other) === null) {
      if (advanceTimer) { window.clearTimeout(advanceTimer); }
      advanceTimer = window.setTimeout(function () {
        advanceTimer = null;
        setTab(other);
      }, AUTO_ADVANCE_MS);
    }
  });

  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () { setTab(btn.getAttribute('data-tab')); });
  });

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  document.querySelector('.tabs').addEventListener('keydown', function (ev) {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') { return; }
    ev.preventDefault();
    setTab(activeTab === 'girl' ? 'boy' : 'girl', true);
  });

  $('search').addEventListener('input', applySearch);
  $('search').addEventListener('keydown', function (ev) {
    // Enter in the search field must not submit the vote.
    if (ev.key === 'Enter') { ev.preventDefault(); $('search').blur(); }
  });
  $('search-clear').addEventListener('click', function () {
    $('search').value = '';
    applySearch();
    $('search').focus();
  });
  $('view-form').addEventListener('submit', submit);
  $('btn-retry').addEventListener('click', function () {
    if (!client) { window.location.reload(); return; }
    load();
  });

  load();
})();
