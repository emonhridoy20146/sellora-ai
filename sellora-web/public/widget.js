/*
 * Sellora website chat loader.
 * <script src="https://YOUR-SELLORA-SITE/widget.js" data-key="wc_…" async></script>
 * Adds the chat bubble in an iframe. The page can open it with window.SelloraChat.open().
 */
(function () {
  'use strict';
  if (window.SelloraChat) return;
  var script =
    document.currentScript ||
    (function () {
      var all = document.querySelectorAll('script[data-key][src*="widget.js"]');
      return all[all.length - 1];
    })();
  if (!script) return;
  var key = script.getAttribute('data-key') || '';
  if (!/^wc_[A-Za-z0-9_-]{24}$/.test(key)) {
    console.warn('Sellora chat: the data-key on the script tag is missing or wrong.');
    return;
  }
  var origin = new URL(script.src, window.location.href).origin;
  var CLOSED = { width: '72px', height: '72px', right: '12px', bottom: '12px' };

  var frame = document.createElement('iframe');
  frame.src = origin + '/widget/' + encodeURIComponent(key);
  frame.title = 'Chat';
  frame.setAttribute('aria-label', 'Chat');
  var s = frame.style;
  s.position = 'fixed';
  s.border = '0';
  s.zIndex = '2147483000';
  s.background = 'transparent';
  s.colorScheme = 'light';
  s.display = 'none';
  s.maxWidth = '100vw';
  s.maxHeight = '100vh';

  function place(open) {
    var small = window.innerWidth < 640;
    s.borderRadius = open && !small ? '16px' : '0';
    s.boxShadow = open && !small ? '0 12px 40px rgba(0, 0, 0, 0.18)' : 'none';
    if (open && small) {
      s.width = '100vw';
      s.height = '100%';
      s.right = '0';
      s.bottom = '0';
    } else if (open) {
      s.width = '380px';
      s.height = 'min(640px, calc(100vh - 24px))';
      s.right = '12px';
      s.bottom = '12px';
    } else {
      s.width = CLOSED.width;
      s.height = CLOSED.height;
      s.right = CLOSED.right;
      s.bottom = CLOSED.bottom;
    }
  }
  place(false);

  var isOpen = false;
  window.addEventListener('message', function (e) {
    if (e.origin !== origin || e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || d.source !== 'sellora-widget') return;
    if (d.type === 'ready') s.display = 'block';
    else if (d.type === 'unavailable') frame.remove();
    else if (d.type === 'open' || d.type === 'close') {
      isOpen = d.type === 'open';
      place(isOpen);
    }
  });
  window.addEventListener('resize', function () {
    place(isOpen);
  });

  function mount() {
    document.body.appendChild(frame);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  window.SelloraChat = {
    open: function () {
      if (frame.contentWindow)
        frame.contentWindow.postMessage({ source: 'sellora-host', type: 'open' }, origin);
    },
  };
})();
