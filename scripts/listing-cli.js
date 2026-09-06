/* 命令行挂单 / 撤单 / 改价
 *
 * 前端需要钱包才能操作；想在脚本里快速造点链上数据（比如给「市场在售一览」
 * 造一条挂单来验证渲染），用这个最省事。
 *
 * 注意：hardhat 的 CLI 不接受自定义位置参数（会报 HH308），所以参数走环境变量：
 *
 *   PowerShell:
 *     $env:LC_CMD="list"; $env:LC_TOKEN="5"; $env:LC_PRICE="0.001"
 *     npx hardhat run scripts/listing-cli.js --network sepolia
 *
 *   bash:
 *     LC_CMD=list LC_TOKEN=5 LC_PRICE=0.001 npx hardhat run scripts/listing-cli.js --network sepolia
 *
 * LC_CMD 取值：list（挂单）/ cancel（撤单）/ price（改价）/ status（只看不写，默认）
 *
 * 用的是 hardhat 配置里的第一个账户（即 .env 里的部署私钥）。
 * 挂单前会自动检查市场授权，没授权就先补一笔 setApprovalForAll。
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

function dep(name) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", name), "utf8")
  );
}
const EXPLORER = "https://sepolia.etherscan.io";

async function main() {
  const cmd = (process.env.LC_CMD || "status").toLowerCase();
  const tokenId = process.env.LC_TOKEN;
  const priceEth = process.env.LC_PRICE;

  const [me] = await hre.ethers.getSigners();
  const mktD = dep("simplemarket-sepolia.json");
  const nftD = dep("mynft-sepolia.json");

  const market = await hre.ethers.getContractAt("SimpleMarket", mktD.address);
  const nft = await hre.ethers.getContractAt("MyNFT", nftD.address);
  const marketW = market.connect(me);
  const nftW = nft.connect(me);

  console.log("账户   : " + me.address);
  console.log("NFT    : " + nftD.address);
  console.log("Market : " + mktD.address);

  if (cmd === "status") {
    const top = Number(await nft.nextTokenId());
    const approved = await nft.isApprovedForAll(me.address, mktD.address);
    console.log("市场授权: " + (approved ? "已授权" : "未授权"));
    console.log("");
    console.log("tokenId  持有人                卖家                 在售  价格(ETH)");
    for (let i = 0; i < top; i++) {
      let holder = "(已销毁)";
      try {
        holder = await nft.ownerOf(i);
      } catch (_) {}
      const r = await market.getListing(nftD.address, i);
      console.log(
        "  " +
          String(i).padEnd(8) +
          (holder === "(已销毁)" ? holder : holder.slice(0, 6) + "..." + holder.slice(-4)).padEnd(20) +
          (r[0] === hre.ethers.ZeroAddress ? "-".padEnd(20) : (r[0].slice(0, 6) + "..." + r[0].slice(-4)).padEnd(20)) +
          String(r[2]).padEnd(6) +
          (r[2] ? hre.ethers.formatEther(r[1]) : "-")
      );
    }
    return;
  }

  if (!tokenId) throw new Error("缺少 tokenId 参数");
  if (cmd === "list" || cmd === "price") {
    if (!priceEth) throw new Error(cmd === "list" ? "缺少价格参数" : "缺少新价格参数");
  }

  // 挂单需要市场先拿到 ERC721 授权
  if (cmd === "list") {
    const approved = await nft.isApprovedForAll(me.address, mktD.address);
    if (!approved) {
      console.log("\n未授权市场，先补一笔 setApprovalForAll…");
      const tx = await nftW.setApprovalForAll(mktD.address, true);
      const rc = await tx.wait();
      console.log("  授权完成 | 区块 " + rc.blockNumber + " | " + EXPLORER + "/tx/" + tx.hash);
    } else {
      console.log("市场授权: 已授权");
    }
  }

  let tx, label;
  if (cmd === "list") {
    label = "挂单 #" + tokenId + " @ " + priceEth + " ETH";
    tx = await marketW.list(nftD.address, tokenId, hre.ethers.parseEther(priceEth));
  } else if (cmd === "cancel") {
    label = "撤单 #" + tokenId;
    tx = await marketW.cancel(nftD.address, tokenId);
  } else if (cmd === "price") {
    label = "改价 #" + tokenId + " → " + priceEth + " ETH";
    tx = await marketW.updatePrice(nftD.address, tokenId, hre.ethers.parseEther(priceEth));
  } else {
    throw new Error("未知命令：" + cmd + "（可用：list / cancel / price / status）");
  }

  console.log("\n提交：" + label + " …");
  const rc = await tx.wait();
  console.log("成功 | 区块 " + rc.blockNumber + " | gas " + rc.gasUsed.toString());
  console.log(EXPLORER + "/tx/" + tx.hash);

  const r = await market.getListing(nftD.address, tokenId);
  console.log(
    "当前状态: " +
      (r[2]
        ? "在售，卖家 " + r[0] + "，价格 " + hre.ethers.formatEther(r[1]) + " ETH"
        : "无有效挂单")
  );
}

main().catch((e) => {
  console.error("\n失败：" + (e.shortMessage || e.message));
  process.exit(1);
});
