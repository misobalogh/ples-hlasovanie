// Public voting page logic.
(function () {
  'use strict';

  var cfg = window.PLES_CONFIG;
  var KEY_DEVICE = cfg.STORAGE_PREFIX + ':device_id';
  var KEY_VOTED = cfg.STORAGE_PREFIX + ':voted';

  var VIEWS = ['loading', 'error', 'closed', 'already', 'thanks', 'form'];
  var FIELDS = ['girl-first', 'girl-last', 'boy-first', 'boy-last'];
  var HAS_LETTER = /\p{L}/u;

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

  // ---------- form ----------

  function value(id) { return $(id).value.replace(/\s+/g, ' ').trim(); }

  function validPart(id) {
    var v = value(id);
    return v.length > 0 && v.length <= 40 && HAS_LETTER.test(v);
  }

  function markField(id, bad) {
    var input = $(id);
    input.classList.toggle('is-invalid', bad);
    if (bad) { input.setAttribute('aria-invalid', 'true'); } else { input.removeAttribute('aria-invalid'); }
  }

  // Lowercase without diacritics, for the accusative heuristic below.
  function plain(text) {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  // "Luciu Novakovu" is the accusative form people tend to type after
  // "I vote for ...". Feminine names in the base form almost never end in -u.
  function looksDeclinedGirl() {
    return /u$/.test(plain(value('girl-first'))) || /(ovu|sku|cku|dzu|nu)$/.test(plain(value('girl-last')));
  }

  var warnedFor = null; // the girl name the warning was shown for

  function resetForm() {
    FIELDS.forEach(function (id) { $(id).value = ''; markField(id, false); });
    $('warn-girl').hidden = true;
    warnedFor = null;
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
    btn.disabled = on;
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

    client.from('settings').select('voting_open').limit(1).maybeSingle()
      .then(function (res) {
        if (res.error) { throw res.error; }
        if (!res.data || !res.data.voting_open) { show('closed'); return; }
        setFormError('');
        resetForm();
        show('form');
      })
      .catch(function (err) {
        console.error(err);
        showError();
      });
  }

  function showThanks() {
    // GIFs load only now, so voters do not download them up front.
    document.querySelectorAll('img[data-gif]').forEach(function (img) {
      if (!img.getAttribute('src')) { img.src = img.getAttribute('data-gif'); }
    });
    show('thanks');
  }

  function submit(ev) {
    ev.preventDefault();
    if (submitting) { return; } // guards against double tap / double click

    var girlOk = validPart('girl-first') && validPart('girl-last');
    var boyOk = validPart('boy-first') && validPart('boy-last');
    FIELDS.forEach(function (id) { markField(id, !validPart(id)); });
    if (!girlOk || !boyOk) {
      setFormError(t(!girlOk ? 'need-girl' : 'need-boy'));
      var firstBad = FIELDS.filter(function (id) { return !validPart(id); })[0];
      if (firstBad) { $(firstBad).focus(); }
      return;
    }

    // Ask once if the queen's name looks declined; a second tap sends it.
    var girlName = value('girl-first') + ' ' + value('girl-last');
    if (looksDeclinedGirl() && warnedFor !== girlName) {
      warnedFor = girlName;
      $('warn-girl').hidden = false;
      setFormError('');
      $('card-girl').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    setFormError('');
    setSubmitting(true);

    client
      .rpc('cast_vote', {
        p_device_id: getDeviceId(),
        p_girl_first: value('girl-first'),
        p_girl_last: value('girl-last'),
        p_boy_first: value('boy-first'),
        p_boy_last: value('boy-last'),
      })
      .then(function (res) {
        if (!res.error) {
          markVoted();
          showThanks();
          return;
        }
        var msg = res.error.message || '';
        if (msg === 'already_voted') {
          markVoted();
          show('already');
        } else if (msg === 'voting_closed') {
          show('closed');
        } else if (msg === 'invalid_girl' || msg === 'invalid_boy') {
          setFormError(t(msg === 'invalid_girl' ? 'need-girl' : 'need-boy'));
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
  FIELDS.forEach(function (id, i) {
    var input = $(id);
    input.addEventListener('input', function () {
      if (input.classList.contains('is-invalid') && validPart(id)) { markField(id, false); }
      if (id.indexOf('girl') === 0) { $('warn-girl').hidden = true; warnedFor = null; }
    });
    // Enter moves to the next field; on the last one it submits.
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || i === FIELDS.length - 1) { return; }
      ev.preventDefault();
      $(FIELDS[i + 1]).focus();
    });
  });
  $('view-form').addEventListener('submit', submit);
  $('btn-retry').addEventListener('click', function () {
    if (!client) { window.location.reload(); return; }
    load();
  });

  load();
})();
