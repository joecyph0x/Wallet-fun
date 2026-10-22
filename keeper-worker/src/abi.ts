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

export const SEL = {
  whaleCount: "0x3ed96f41",
  whales: "0xeb1d2d40",
  listings: "0x65d96c82",
  lastSettleTs: "0xe89da2f3",
  openOrders: "0xb0ece8fb",
  lastEquity: "0xff35d088",
  lastNtlPos: "0x70da37a0",
} as const;
