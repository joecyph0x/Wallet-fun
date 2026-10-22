import assert from "node:assert/strict";
import { test } from "node:test";
import type { WhaleEvent } from "./events.js";
import { canPost, emptyRate, type Limits } from "./rate.js";
import {
  PLAIN_MILLI,
  URL_MILLI,
  compose,
  containsUrlOrDomain,
  costMilli,
  formatPays,
  formatPx,
  formatUsd,
  oddsLine,
} from "./templates.js";

const now = Date.UTC(2026, 9, 22, 15, 0, 0);
const limits: Limits = { maxPerDay: 14, minGapSec: 1_200, maxSpendMilli: 300 };
const odds = { tail: 10_000, fade: 8_000 };

function ev(over: Partial<WhaleEvent> & Pick<WhaleEvent, "kind" | "ticker" | "coin">): WhaleEvent {
  return {
    side: "long",
    notional: 5_200_000,
    entry: 3_412,
    pnl: 0,
    addFrac: 0,
    score: 5_200_000,
    ...over,
  };
}

const kinds: WhaleEvent[] = [
  ev({ kind: "open", ticker: "MACHI", coin: "ETH" }),
  ev({ kind: "close", ticker: "WYNN", coin: "BTC", side: "short", pnl: -1_400_000, score: 1_400_000 }),
  ev({ kind: "flip", ticker: "JEFF", coin: "ETH", side: "long", prevSide: "short", notional: 2_100_000 }),
  ev({ kind: "add", ticker: "BOBBY", coin: "SOL", notional: 3_400_000, addFrac: 0.8 }),
  ev({ kind: "swing", ticker: "HLP", coin: "ETH", pnl: 1_200_000, score: 1_200_000 }),
  ev({ kind: "open", ticker: "SILK", coin: "x.com" }),
];

test("dollar, price, and payout formatting", () => {
  assert.equal(formatUsd(5_200_000), "$5.2M");
  assert.equal(formatUsd(1_000_000), "$1M");
  assert.equal(formatUsd(1_200), "$1.2K");
  assert.equal(formatUsd(840), "$840");
  assert.equal(formatUsd(-1_400_000, true), "-$1.4M");
  assert.equal(formatUsd(1_200_000, true), "+$1.2M");
  assert.equal(formatPx(3_412), "3,412");
  assert.equal(formatPx(0.45), "0.45");
  assert.equal(formatPays(1.8), "1.8x");
  assert.equal(formatPays(2), "2x");
  assert.equal(formatPays(2.2), "2.2x");
  assert.equal(oddsLine(odds), "TAIL pays 1.8x · FADE pays 2.3x");
  assert.equal(oddsLine(null), "");
});

test("none mode never contains a URL or a bare domain", () => {
  const footers = { bio: 0, dot: 0, season: 0, bare: 0 };
  for (const event of kinds) {
    for (let variant = 0; variant < 12; variant++) {
      const text = compose({
        ticker: event.ticker,
        events: [event],
        odds,
        now,
        linkMode: "none",
        variant,
      });
      assert.equal(containsUrlOrDomain(text), false, text);
      assert.equal(text.includes("@"), false, text);
      assert.equal(text.includes("whalewallet.fun"), false, text);
      assert.equal(text.toLowerCase().includes("x.com"), false, text);
      assert.ok(text.length <= 280, text);
      assert.equal(costMilli(text), PLAIN_MILLI, text);
      if (text.includes("link in bio")) footers.bio++;
      if (text.includes("whalewallet dot fun")) footers.dot++;
      if (text.includes("Season 0, points only")) footers.season++;
      if (!text.includes("link in bio") && !text.includes("whalewallet dot fun") && !text.includes("Season 0, points only")) {
        footers.bare++;
      }
    }
    const recap = compose({
      ticker: event.ticker,
      now,
      linkMode: "none",
      recap: true,
      whaleCount: 11,
      biggest: { ticker: "MACHI", coin: "ETH", side: "long", notional: 5_200_000 },
      variant: 3,
    });
    assert.equal(containsUrlOrDomain(recap), false, recap);
    assert.equal(costMilli(recap), PLAIN_MILLI);
  }
  assert.ok(footers.bio > 0 && footers.dot > 0 && footers.season > 0 && footers.bare > 0);
  assert.ok(footers.season < kinds.length * 12);
  assert.ok(footers.bio < kinds.length * 12);
});

test("voice lines and the link modes", () => {
  const open = compose({
    ticker: "MACHI",
    events: [ev({ kind: "open", ticker: "MACHI", coin: "ETH" })],
    odds,
    now,
    linkMode: "none",
    variant: 3,
  });
  assert.equal(open, "🐋 MACHI just opened a $5.2M ETH long at 3,412. TAIL pays 1.8x · FADE pays 2.3x");

  const withBio = compose({
    ticker: "MACHI",
    events: [ev({ kind: "open", ticker: "MACHI", coin: "ETH" })],
    odds,
    now,
    linkMode: "none",
    variant: 0,
  });
  assert.ok(withBio.endsWith("\nlink in bio"));
  assert.equal(containsUrlOrDomain(withBio), false);

  const dotted = compose({
    ticker: "MACHI",
    events: [ev({ kind: "open", ticker: "MACHI", coin: "ETH" })],
    odds,
    now,
    linkMode: "none",
    variant: 1,
  });
  assert.ok(dotted.endsWith("\nwhalewallet dot fun"));

  assert.equal(
    compose({
      ticker: "WYNN",
      events: [ev({ kind: "close", ticker: "WYNN", coin: "BTC", side: "short", pnl: -1_400_000 })],
      now,
      linkMode: "none",
      variant: 3,
    }),
    "💀 WYNN closed the BTC short. Realised -$1.4M.",
  );
  assert.equal(
    compose({
      ticker: "JEFF",
      events: [ev({ kind: "flip", ticker: "JEFF", coin: "ETH", side: "long", prevSide: "short", notional: 2_100_000 })],
      now,
      linkMode: "none",
      variant: 3,
    }),
    "🔄 JEFF flipped ETH short → long, $2.1M.",
  );
  assert.equal(
    compose({
      ticker: "BOBBY",
      events: [ev({ kind: "add", ticker: "BOBBY", coin: "SOL", notional: 3_400_000, addFrac: 0.8 })],
      now,
      linkMode: "none",
      variant: 3,
    }),
    "🐋 BOBBY added 80% to the SOL long. Now $3.4M.",
  );
  assert.equal(
    compose({
      ticker: "HLP",
      events: [ev({ kind: "swing", ticker: "HLP", coin: "ETH", pnl: 1_200_000 })],
      now,
      linkMode: "none",
      variant: 3,
    }),
    "📈 HLP ETH long is up $1.2M uPnL.",
  );

  const noOdds = compose({
    ticker: "MACHI",
    events: [ev({ kind: "open", ticker: "MACHI", coin: "ETH" })],
    odds: null,
    now,
    linkMode: "none",
    variant: 3,
  });
  assert.equal(noOdds.includes("TAIL"), false);

  const collapsed = compose({
    ticker: "MACHI",
    events: [
      ev({ kind: "open", ticker: "MACHI", coin: "ETH", score: 5 }),
      ev({ kind: "flip", ticker: "MACHI", coin: "BTC", score: 4, prevSide: "short", side: "long" }),
      ev({ kind: "swing", ticker: "MACHI", coin: "SOL", score: 1, pnl: 1_000_000 }),
    ],
    now,
    linkMode: "none",
    variant: 3,
  });
  assert.ok(collapsed.includes("ETH"));
  assert.ok(collapsed.includes("BTC"));
  assert.ok(collapsed.includes("+1 more"));
  assert.equal(collapsed.includes("@"), false);
  assert.ok(collapsed.length <= 280);

  const silk = compose({
    ticker: "SILK",
    events: [ev({ kind: "open", ticker: "SILK", coin: "BTC" })],
    now,
    linkMode: "none",
    variant: 3,
  });
  assert.equal(silk.includes("@"), false);
  assert.equal(silk.toLowerCase().includes("silkbtc"), false);

  const dailyEvent = compose({
    ticker: "MACHI",
    events: [ev({ kind: "open", ticker: "MACHI", coin: "ETH" })],
    now,
    linkMode: "daily",
    variant: 0,
  });
  assert.equal(containsUrlOrDomain(dailyEvent), false);
  assert.equal(costMilli(dailyEvent), PLAIN_MILLI);

  const dailyRecap = compose({
    ticker: "MACHI",
    now,
    linkMode: "daily",
    recap: true,
    whaleCount: 11,
    biggest: { ticker: "MACHI", coin: "ETH", side: "long", notional: 5_200_000 },
    variant: 3,
  });
  assert.ok(dailyRecap.includes("https://whalewallet.fun"));
  assert.equal(dailyRecap.includes("#/w/"), false);
  assert.equal(costMilli(dailyRecap), URL_MILLI);

  const all = compose({
    ticker: "MACHI",
    events: [ev({ kind: "open", ticker: "MACHI", coin: "ETH" })],
    odds,
    now,
    linkMode: "all",
    variant: 3,
  });
  assert.ok(all.includes("https://whalewallet.fun/#/w/MACHI"));
  assert.equal(all.includes("link in bio"), false);
  assert.equal(all.includes("whalewallet dot fun"), false);
  assert.equal(costMilli(all), URL_MILLI);
});

test("the detector prices a leaked domain as a URL post and the spend guard uses it", () => {
  assert.equal(containsUrlOrDomain("whalewallet.fun"), true);
  assert.equal(containsUrlOrDomain("whalewallet dot fun"), false);
  assert.equal(containsUrlOrDomain("https://whalewallet.fun/#/w/MACHI"), true);
  assert.equal(containsUrlOrDomain("see www.whalewallet.fun"), true);
  assert.equal(containsUrlOrDomain("TAIL pays 1.8x · FADE pays 2.2x"), false);
  assert.equal(containsUrlOrDomain("$5.2M at 3,412"), false);
  assert.equal(costMilli("whalewallet.fun"), URL_MILLI);
  assert.equal(costMilli("whalewallet dot fun"), PLAIN_MILLI);

  const plain = compose({
    ticker: "MACHI",
    events: [ev({ kind: "open", ticker: "MACHI", coin: "ETH" })],
    odds,
    now,
    linkMode: "none",
    variant: 3,
  });
  assert.equal(canPost(emptyRate(now), now, costMilli(plain), limits).ok, true);

  const linked = compose({
    ticker: "MACHI",
    events: [ev({ kind: "open", ticker: "MACHI", coin: "ETH" })],
    now,
    linkMode: "all",
    variant: 3,
  });
  const afterUrl = { ...emptyRate(now), spentMilli: URL_MILLI, count: 1, lastPostAt: now - 3_600_000 };
  assert.equal(canPost(afterUrl, now, costMilli(linked), limits).reason, "spend");
});
