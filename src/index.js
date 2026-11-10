'use strict';

const { scan } = require('./scan');
const { analyze } = require('./compare');

/**
 * Run a RuntimeGate check against a project root.
 * @param {object} options
 * @param {string} options.root
 * @param {string[]} [options.langs]
 * @param {boolean} [options.eol]
 * @param {Date} [options.now]
 */
function runCheck(options) {
  const collected = scan(options.root, { langs: options.langs, ignore: options.ignore });
  return analyze(collected, {
    eol: Boolean(options.eol),
    now: options.now || new Date(),
  });
}

module.exports = { runCheck };
