/*
 * News timeline on the home page: tags recent items as "New" and folds the
 * older ones behind a button. Without this script the whole list is shown.
 */
(function () {
  'use strict';

  var list = document.getElementById('news-list');
  if (!list) { return; }

  var DAY = 24 * 60 * 60 * 1000;
  var now = Date.now();
  Array.prototype.forEach.call(list.querySelectorAll('.nw-item[data-date]'), function (item) {
    var when = Date.parse(item.getAttribute('data-date') + 'T00:00:00');
    if (!isNaN(when) && now - when < 45 * DAY && now - when > -DAY) { item.classList.add('is-new'); }
  });

  var more = document.getElementById('news-more');
  if (!more) { return; }
  var count = more.getAttribute('data-count');

  function fold(folded) {
    list.classList.toggle('is-collapsed', folded);
    more.setAttribute('aria-expanded', folded ? 'false' : 'true');
    more.textContent = folded ? 'Show earlier news (' + count + ')' : 'Show fewer';
  }

  more.hidden = false;
  fold(true);
  more.addEventListener('click', function () {
    var folding = !list.classList.contains('is-collapsed');
    fold(folding);
    if (folding) { more.scrollIntoView({ block: 'nearest' }); }
  });
})();
