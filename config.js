// Public configuration. Only the publishable (anon) key belongs here.
// Never put a service role / secret key in this repository.
window.PLES_CONFIG = Object.freeze({
  EVENT_TITLE: 'Ples 2026',
  SUPABASE_URL: 'https://scdfmuupgotdumgzsxct.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable__IPzjL8bsrt-hUTxjakVfw_IMdNkkFb',
  // Optional: fixed voting URL for qr.html. Leave empty to derive it
  // automatically from the address of qr.html (same folder, index.html).
  VOTE_URL: '',
  // Change when reusing the app for another event, so old "already voted"
  // flags stored in phones do not block the new vote.
  STORAGE_PREFIX: 'ples2026',
});
