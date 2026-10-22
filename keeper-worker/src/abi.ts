export const settleAbi = [
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "assets",
        type: "tuple[]",
        components: [
          { name: "memberIndex", type: "uint8" },
          { name: "perp", type: "uint32" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/** Settled(address,address,int256,int256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint64,bool). Caller is topic 2. */
export const SETTLED_TOPIC = "0xd580737e1f67261d52cb58caaf1d232c13212d6e514b75a50aa997a9f0236ef2";

export const SEL = {
  whaleCount: "0x3ed96f41",
  whales: "0xeb1d2d40",
  listings: "0x65d96c82",
  lastSettleTs: "0xe89da2f3",
  openOrders: "0xb0ece8fb",
  lastEquity: "0xff35d088",
  lastNtlPos: "0x70da37a0",
} as const;
