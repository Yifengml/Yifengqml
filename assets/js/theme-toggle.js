/*
 * Day / night mode button.
 *
 * The page starts in day mode. A click on the button in the header switches
 * the mode and remembers the choice in this browser. The stored choice is
 * applied early by the small script in _includes/head.html, so a returning
 * visitor never sees a flash of the other mode.
 */
(function () {
  'use strict';

  var KEY = 'theme';
  var root = document.documentElement;
  var button = document.getElementById('theme-toggle');

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { meta.setAttribute('content', theme === 'dark' ? '#121519' : '#ffffff'); }
    if (button) {
      button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      button.setAttribute('title', theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode');
    }
  }

  apply(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

  if (!button) { return; }
  button.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.classList.add('theme-switching');
    apply(next);
    try { localStorage.setItem(KEY, next); } catch (err) { /* private browsing: the choice just is not remembered */ }
    setTimeout(function () { root.classList.remove('theme-switching'); }, 450);
  });
})();
