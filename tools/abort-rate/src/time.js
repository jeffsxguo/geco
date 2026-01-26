function nowMs() {
  return Date.now();
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { nowMs, sleepMs };

