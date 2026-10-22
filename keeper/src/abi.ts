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
