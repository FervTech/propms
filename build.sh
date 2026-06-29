#!/bin/bash

# Generate env.js from environment variables
cat > env.js << EOF
// ── Generated at deploy time ──
(function(){
  const env = window.__ENV || {};
  window.ENV = {
    SUPABASE_URL: env.SUPABASE_URL || '$SUPABASE_URL',
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY || '$SUPABASE_ANON_KEY',
    SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY || '$SUPABASE_SERVICE_KEY',
    APP_NAME: env.APP_NAME || '$APP_NAME',
    APP_VERSION: env.APP_VERSION || '$APP_VERSION',
    get CONFIGURED() {
      return !!(this.SUPABASE_URL && this.SUPABASE_ANON_KEY &&
        this.SUPABASE_URL !== '$SUPABASE_URL' &&
        this.SUPABASE_ANON_KEY !== '$SUPABASE_ANON_KEY');
    },
  };
})();
EOF
