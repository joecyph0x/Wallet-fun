/** Pure helpers for /health. The numbers come from the chain, not from isolate memory. */

export type LogRow = { blockNumber?: string; transactionHash?: string; logIndex?: string };

export function pickLatestLog(logs: readonly LogRow[]): { hash: string; block: number } | null {
  let best: { hash: string; block: number; index: number } | null = null;
  for (const log of logs) {
    if (!log.transactionHash || log.blockNumber == null) continue;
    const block = Number(log.blockNumber);
    const index = Number(log.logIndex ?? "0x0");
    if (!Number.isFinite(block) || !Number.isFinite(index)) continue;
    if (!best || block > best.block || (block === best.block && index > best.index)) {
      best = { hash: log.transactionHash, block, index };
    }
  }
  return best ? { hash: best.hash, block: best.block } : null;
}

/** Seconds since the market's last settlement. Null when it has never settled. */
export function settleAgeSec(lastSettleTs: number, nowSec: number): number | null {
  if (!lastSettleTs) return null;
  return nowSec - lastSettleTs;
}

/**
 * A market that has settled before, and is now more than two epochs late.
 * A brand-new market (lastSettleTs 0) is not flagged here.
 */
export function settleStalled(lastSettleTs: number, nowSec: number, epochSec: number): boolean {
  if (!lastSettleTs || !Number.isInteger(epochSec) || epochSec <= 0) return false;
  if (!Number.isInteger(nowSec) || nowSec < lastSettleTs) return false;
  return nowSec - lastSettleTs > epochSec * 2;
}
