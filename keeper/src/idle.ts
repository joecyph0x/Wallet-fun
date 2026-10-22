/** Idle-skip rule. A whale with no open positions and an unchanged account value since the last
 *  settle moves no pot value, so settling it again only refreshes the heartbeat. Skip it unless
 *  orders are queued (settle fills them), it has never been settled by this process, the queue
 *  could not be read, or the idle heartbeat has passed. */
export type IdleInput = {
  everSettled: boolean;
  sameAsLastSettle: boolean;
  openOrders: bigint | undefined;
  sinceLastMs: number;
  idleHeartbeatMs: number;
};

export function shouldSettle(x: IdleInput): boolean {
  if (!x.everSettled || !x.sameAsLastSettle) return true;
  if (x.openOrders === undefined || x.openOrders > 0n) return true;
  return x.sinceLastMs >= x.idleHeartbeatMs;
}
