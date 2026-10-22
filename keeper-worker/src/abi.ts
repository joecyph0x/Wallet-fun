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

/** v2 Settled. Caller is topic 2. */
export const SETTLED_TOPIC = "0xd580737e1f67261d52cb58caaf1d232c13212d6e514b75a50aa997a9f0236ef2";

/** v3 Settled(address,address,uint64,int256,int256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint64,bool). Caller is topic 2. */
export const SETTLED_TOPIC_V3 = "0x2137de76dc2f5c6c0d89767d799bb463bff9e1252cbb2c7aefc325b80f96e7f9";

export const SEL = {
  whaleCount: "0x3ed96f41",
  whales: "0xeb1d2d40",
  listings: "0x65d96c82",
  lastSettleTs: "0xe89da2f3",
  openOrders: "0xb0ece8fb",
  memberCount: "0x11aee380",
  dexCount: "0xab304695",
  lastEquity: "0xff35d088",
  lastNtlPos: "0x70da37a0",
} as const;
