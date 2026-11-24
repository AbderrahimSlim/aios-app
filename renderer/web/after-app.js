/* HOST MODE (browser) — adjustments that must run after app.js has defined its globals.

   app.js builds file:// URLs for its viewers (images, PDFs, HTML exports). A page served over
   http(s) may not load file://, and the file lives on the host anyway, so the same path is asked of
   the host's /hostfile route instead (which only serves inside the allowed roots). `fileUrl` is a
   top-level function declaration in a classic script, hence a writable global. */
(function () {
  'use strict';
  if (!window.glassShell || !window.glassShell.hostMode) return;
  if (typeof window.fileUrl === 'function') {
    window.fileUrl = function (p) { return '/hostfile?p=' + encodeURIComponent(String(p)); };
  }
})();
