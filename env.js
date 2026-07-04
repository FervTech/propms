// PropMS — Environment / Credentials (env.js)
//
// !! NEVER commit this file to git !!
// Add env.js to your .gitignore
//
(function () {
  const env = window.__ENV || {};

  window.ENV = {
    SUPABASE_URL:         env.SUPABASE_URL         || '',
    SUPABASE_ANON_KEY:    env.SUPABASE_ANON_KEY    || '',
    SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY || '',
    APP_NAME:             env.APP_NAME             || 'PropMS',
    APP_VERSION:          env.APP_VERSION          || '2.0.0',

    get CONFIGURED() {
      return !!(this.SUPABASE_URL && this.SUPABASE_ANON_KEY &&
        this.SUPABASE_URL !== 'your_supabase_url_here' &&
        this.SUPABASE_ANON_KEY !== 'your_anon_key_here');
    },
  };
})();
