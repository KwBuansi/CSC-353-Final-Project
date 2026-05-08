/**
 * Shared localStorage helpers for QR codes (index.html + ViewCodes.html).
 */
(function () {
  'use strict';

  var KEY = 'qrCodes';

  function read() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || [];
    } catch {
      return [];
    }
  }

  function save(arr) {
    localStorage.setItem(KEY, JSON.stringify(arr));
  }

  window.QrCodesStorage = { read: read, save: save, KEY: KEY };
})();
