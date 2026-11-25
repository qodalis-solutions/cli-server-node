'use strict';
exports.greet = (greeting, name, times) => Array.from({ length: times }, () => `${greeting}, ${name}!`).join(' ');
