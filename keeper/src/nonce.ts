/** Local nonce cursor. The testnet RPC's pending count lags a tx that was just submitted. */
export type NonceCursor = { next?: number };

/** First call uses the node's pending nonce. Later calls increment locally. */
export function takeNonce(cursor: NonceCursor, pendingFromNode: number): number {
  if (cursor.next === undefined) cursor.next = pendingFromNode;
  const nonce = cursor.next;
  cursor.next = nonce + 1;
  return nonce;
}

/** Drop the cursor so the next take reads the node again. Use after a rejected send. */
export function resetNonce(cursor: NonceCursor): void {
  cursor.next = undefined;
}
