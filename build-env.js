// build-env.js — runs during Netlify build
const fs = require('fs');

const content = `window.__ENV = {
  SUPABASE_URL:         '${process.env.SUPABASE_URL         || ''}',
  SUPABASE_ANON_KEY:    '${process.env.SUPABASE_ANON_KEY    || ''}',
  SUPABASE_SERVICE_KEY: '${process.env.SUPABASE_SERVICE_KEY || ''}',
  APP_NAME:             '${process.env.APP_NAME             || 'PropMS'}',
  APP_VERSION:          '${process.env.APP_VERSION          || '2.0.0'}'
};`;

fs.writeFileSync('__env.js', content);
console.log('__env.js generated ✓');
