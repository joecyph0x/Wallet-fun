/**
 * The eleven public Season 0 whales. DEMO is testnet-only and is not tracked.
 * Tickers only. Display names are never used: SILK's name is an X handle.
 * Addresses match contracts/deployments/998.json.
 */

export type Whale = {
  ticker: string;
  whale: string;
  market: string;
};

export const WHALES: readonly Whale[] = [
  { ticker: "MACHI", whale: "0x020ca66c30bec2c4fe3861a94e4db4a498a35872", market: "0x08ACeA438F93ff816C4ACA733F89667752DD9B8c" },
  { ticker: "BOBBY", whale: "0x7fdafde5cfb5465924316eced2d3715494c517d1", market: "0x0aeFE1f1d097e1D0178510c110cD045ea91f6D62" },
  { ticker: "HLP", whale: "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303", market: "0x337ce7f4FDEFaad4516820aA44cab332A2Cb3926" },
  { ticker: "FAUVES", whale: "0x49e96e255ba418d08e66c35b588e2f2f3766e1d0", market: "0xd17c7f34B1fF54e00c20Dde5C164afF3eB97C9A7" },
  { ticker: "NMTD", whale: "0xf517639a8872e756ac98d3c65507d2ebc25cc032", market: "0xeD9fA5d874EA0f540533AbDeB8a6ed29eECbe170" },
  { ticker: "SILK", whale: "0x880ac484a1743862989a441d6d867238c7aa311c", market: "0x9b4699A593A215E7899B8f0ADFFBdBC1fABaa30B" },
  { ticker: "JEFF", whale: "0x1367df28c0681431b8a8f3d887576a1cad85560e", market: "0xad33Cd7596291d4C392befA2D8C4Be279F87672D" },
  { ticker: "CATHOT", whale: "0xcb58b8f5ec6d47985f0728465c25a08ef9ad2c7b", market: "0x9ADcB2FEBCE18C67C65cc3920252dAbdd56c6C22" },
  { ticker: "PURRINA", whale: "0x0871deb34bfd2052b1c10dc4f6c0912a2a47e927", market: "0x361838AEAFF887911734F8F6648DD96008225017" },
  { ticker: "FUMBLER", whale: "0x523852be2db1a76a0e088ecbff32e849544054e5", market: "0x7F495eCAb0216f6A7314A3fbC6496C4d7184fD07" },
  { ticker: "WYNN", whale: "0x5078c2fbea2b2ad61bc840bc023e35fce56bedb6", market: "0xc8Ed33C46Fa9F1E343C442A3532fd39DC9995394" },
];

export const DEMO_WHALE = "0x6dd538c00055d7ea6d451b97a94e463e8ce89519";
