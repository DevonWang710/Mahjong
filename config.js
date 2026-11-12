module.exports = {
  PORT: process.env.PORT || 3000,
  // Minimum faan needed to declare a win. 0 = any complete hand ("chicken hand") wins.
  MIN_FAAN: 0,
  // How long bots "think" before acting (ms). Each move varies randomly by ±30%.
  BOT_DELAY_MS: 1500,
  // Seconds a real player gets for each decision (draw, discard, claim). When it runs out the game moves for them.
  TURN_SECONDS: 60,
  // How long the deal animation runs before the first move (ms).
  DEAL_MS: 2600,
  // Faan above this all score the same (limit hand).
  FAAN_CAP: 8,
  BOT_NAMES: ['Bunny', 'Barthalamule', 'Wilbur'],
};
