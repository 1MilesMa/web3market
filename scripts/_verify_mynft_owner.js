const hre = require("hardhat");

async function main() {
  const MyNFT = "0x9EFe00123a6A22d903D63E195B7E87Bf3622412e";
  const nft = await hre.ethers.getContractAt("MyNFT", MyNFT);
  const owner = await nft.owner();
  console.log("MyNFT.owner() =", owner);
  console.log("isTimelock =", owner.toLowerCase() === "0xdf0886dcfeb54538cdc9df59bf0e7e3e061ee119");
  let pending = "N/A";
  try { pending = await nft.pendingOwner(); } catch (e) { pending = "N/A"; }
  console.log("pendingOwner() =", pending);
}

main().catch((e) => { console.error(e); process.exit(1); });
