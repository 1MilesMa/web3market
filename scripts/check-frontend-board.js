/* 前端「市场在售一览」的链上逻辑预演
 *
 * 这个脚本不走浏览器，而是把 app.js 里 refreshMarket() 干的事
 * 原样跑一遍：读 nextTokenId → 逐个 getListing → 只留 active。
 * 用来确认「卡片里将显示的每一行」与链上真实状态一致，
 * 并和 scripts/market-board.js 的交叉验证结论对上。
 *
 * 只读，不上链、不花 gas。
 *   npx hardhat run scripts/check-frontend-board.js --network sepolia
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

function short(a) {
  return !a ? "-" : a.slice(0, 6) + "..." + a.slice(-4);
}

async function main() {
  const dep = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "deployments", "simplemarket-sepolia.json"),
      "utf8"
    )
  );
  const nftDep = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "deployments", "mynft-sepolia.json"),
      "utf8"
    )
  );

  const market = await hre.ethers.getContractAt("SimpleMarket", dep.address);
  const nft = await hre.ethers.getContractAt("MyNFT", nftDep.address);

  const top = Number(await nft.nextTokenId());
  const totalSupply = Number(await nft.totalSupply());
  const maxSupply = Number(await nft.maxSupply());

  console.log("============================================================");
  console.log("  前端「市场在售一览」链上预演");
  console.log("============================================================");
  console.log("");
  console.log("  NFT 合约      : " + nftDep.address);
  console.log("  Market 合约   : " + dep.address);
  console.log("  nextTokenId   : " + top + "   （前端会发 " + top + " 次 getListing）");
  console.log("  totalSupply   : " + totalSupply + "   （已销毁 " + (top - totalSupply) + " 枚）");
  console.log("  maxSupply     : " + maxSupply);
  console.log("");

  // —— 与 app.js refreshMarket() 完全相同的循环 ——
  // 逐枚打印的真实返回值，是判断「前端循环会不会被 revert 打断」的依据：
  // 只有确认未挂单 / 已销毁的 tokenId 都返回零值而不是抛错，遍历才是安全的。
  const rows = [];
  const detail = [];
  let rpc = 0;
  let reverted = 0;
  for (let i = 0; i < top; i++) {
    let r;
    try {
      r = await market.getListing(nftDep.address, i);
      rpc++;
    } catch (e) {
      reverted++;
      detail.push({ id: i, reverted: true, msg: (e.shortMessage || e.message).slice(0, 60) });
      continue;
    }
    if (r[2]) rows.push({ tokenId: String(i), seller: r[0], price: r[1] });
    detail.push({ id: i, seller: r[0], price: r[1], active: r[2] });
  }

  // 持有情况：ownerOf 对已销毁的 token 会 revert，据此区分「销毁」与「只是没挂单」
  const holders = [];
  for (let i = 0; i < top; i++) {
    try {
      holders.push(await nft.ownerOf(i));
    } catch (_) {
      holders.push(null); // 已销毁
    }
  }

  console.log("------------------------------------------------------------");
  console.log("  卡片将渲染的内容");
  console.log("------------------------------------------------------------");
  if (!rows.length) {
    console.log("  （扫过 tokenId 0 .. " + (top - 1) + "，当前没有在售挂单）");
    console.log("  → 页面上的胶囊会显示「暂无在售」，与 market-board.js 第 5 节一致");
  } else {
    console.log("  #id      卖家              价格(ETH)");
    for (const r of rows) {
      console.log(
        "  #" + r.tokenId.padEnd(8) +
        short(r.seller).padEnd(18) +
        hre.ethers.formatEther(r.price)
      );
    }
  }
  console.log("");
  console.log("------------------------------------------------------------");
  console.log("  逐枚 getListing 的真实返回值（判断遍历是否安全）");
  console.log("------------------------------------------------------------");
  console.log("  tokenId  持有者            卖家              active   价格(ETH)");
  for (const d of detail) {
    if (d.reverted) {
      console.log("  " + String(d.id).padEnd(9) + "!! getListing revert: " + d.msg);
      continue;
    }
    const holder = holders[d.id] ? short(holders[d.id]) : "(已销毁)";
    console.log(
      "  " +
        String(d.id).padEnd(9) +
        holder.padEnd(18) +
        short(d.seller).padEnd(18) +
        String(d.active).padEnd(10) +
        (d.price === 0n ? "-" : hre.ethers.formatEther(d.price))
    );
  }
  console.log("");
  console.log("  实际发出 getListing 调用 : " + rpc + " 次 | revert " + reverted + " 次");

  // —— 前提核对：未挂单 / 已销毁的 tokenId 不能 revert，否则前端循环会被打断 ——
  const zeroAddr = hre.ethers.ZeroAddress;
  const noListing = detail.filter(
    (d) => !d.reverted && !d.active && d.seller === zeroAddr && d.price === 0n
  );
  const staleListing = detail.filter(
    (d) => !d.reverted && !d.active && !(d.seller === zeroAddr && d.price === 0n)
  );
  console.log("");
  console.log("  前提核对：");
  console.log(
    "    getListing 从不 revert，前端可安全遍历 : " +
      (reverted === 0
        ? "是 ✓"
        : "否 ✗ —— app.js 的 for 循环没有 try/catch，遇到 revert 会整段崩掉")
  );
  console.log(
    "    从未挂过单的 tokenId 返回零值 : " + noListing.length + " 枚（零地址 / 0 / false）"
  );
  console.log(
    "    挂过但已撤下或已成交的残留记录 : " + staleListing.length +
    " 枚（卖家与价格仍留着，只是 active=false）"
  );
  if (staleListing.length) {
    console.log("    → 这正是必须用 active 字段过滤、而不能只看 seller 是不是零地址的原因");
  }
  console.log(
    "    nextTokenId >= 已铸造数量 : " + (top >= totalSupply ? "是 ✓" : "否 ✗")
  );
  console.log("============================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
