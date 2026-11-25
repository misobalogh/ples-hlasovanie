// Public voting page logic.
(function () {
  'use strict';

  var cfg = window.PLES_CONFIG;
  var KEY_DEVICE = cfg.STORAGE_PREFIX + ':device_id';
  var KEY_VOTED = cfg.STORAGE_PREFIX + ':voted';

  var VIEWS = ['loading', 'error', 'closed', 'already', 'thanks', 'form'];

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

    var hint = $('submit-hint');
    if (ready) {
      hint.textContent = t('hint-ready');
    } else if (girl === null && boy === null) {
      hint.textContent = t('hint-none');
    } else if (girl === null) {
      hint.textContent = t('hint-girl');
    } else {
      hint.textContent = t('hint-boy');
    }
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
  $('view-form').addEventListener('change', updateSubmitState);
  $('view-form').addEventListener('submit', submit);
  $('btn-retry').addEventListener('click', function () {
    if (!client) { window.location.reload(); return; }
    load();
  });

  load();
})();
