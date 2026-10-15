'use strict';
// Catalog durations may be rounded to seconds while the player reports milliseconds.
const DURATION_TOLERANCE_MS = 1000;
const validDuration = value => Number.isSafeInteger(value) && value > 0 && value <= 3600000;
const durationsAgree = (left, right) => validDuration(left) && validDuration(right)
  && Math.abs(left - right) <= DURATION_TOLERANCE_MS;
module.exports = { DURATION_TOLERANCE_MS, validDuration, durationsAgree };
