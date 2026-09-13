/* SimpleMarket 前端主逻辑
 * 依赖：vendor/ethers.umd.min.js（ethers v6）、config.js（自动生成）
 * 说明：所有会改链上状态的操作都会弹出钱包确认；只读查询不花 gas。
 */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG;
  var E = window.ethers;
  var $ = function (id) { return document.getElementById(id); };

  var provider, signer, account;
  var nft, market;              // 只读合约（连 provider）
  var nftW, marketW;            // 可写合约（连 signer）
  var abiNft, abiMkt;

  // ---------------------------------------------------------------- 工具

  function short(a) {
    return !a ? "-" : a.slice(0, 6) + "…" + a.slice(-4);
  }
  function ts() {
    var d = new Date();
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) +
           ":" + ("0" + d.getSeconds()).slice(-2);
  }
  function log(msg, kind) {
    var box = $("log");
    var el = document.createElement("div");
    el.className = "lg " + (kind || "i");
    var tspan = document.createElement("span");
    tspan.className = "t";
    tspan.textContent = ts();
    el.appendChild(tspan);
    String(msg).split(/(<a\b[^>]*>[\s\S]*?<\/a>)/g).forEach(function (part) {
      if (/^<a\b/.test(part)) {
        el.insertAdjacentHTML("beforeend", part.replace(/javascript:/gi, ""));
      } else if (part) {
        el.appendChild(document.createTextNode(part));
      }
    });
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }
  function link(kind, hash) {
    return '<a href="' + CFG.explorer + "/" + kind + "/" + hash + '" target="_blank">' + hash + "</a>";
  }
  function need(cond, msg) {
    if (!cond) { log(msg, "e"); return false; }
    return true;
  }

  // 当前 NFT 合约：页面「当前 NFT 合约」输入框是唯一入口，其余区块自动同步
  function nftAddress() {
    var v = (($("curNft") && $("curNft").value) || "").trim();
    return v || CFG.contracts.MyNFT.address;
  }
  var ADDR_IDS = ["lstNft", "buyNft", "offNft", "actNft"];
  function syncAddrInputs() {
    var a = nftAddress();
    ADDR_IDS.forEach(function (id) { if ($(id)) $(id).value = a; });
  }

  // 把链上 revert 原因翻成人话
  var ERRMAP = [
    ["EnforcedPause", "合约已暂停：开仓类操作（挂单/买入/出价/签名成交/铸造）被暂时挡下，撤单与提现不受影响"],
    ["ExpectedPause", "合约当前不是暂停状态，无需解除"],
    ["NotListed", "这枚 NFT 当前没有挂单"],
    ["AlreadyListed", "这枚 NFT 已经挂过单了，请先撤单或改价"],
    ["NotTokenOwner", "你不是这枚 NFT 的持有者"],
    ["MarketNotApproved", "市场还没获得这枚 NFT 的转移授权，请先点「授权市场」"],
    ["InsufficientPayment", "付款金额不足（需 >= 挂单价）"],
    ["InvalidNonce", "签名 nonce 与链上不一致：这条签名已被用过，或卖家已主动作废"],
    ["SignatureExpired", "签名已过 deadline，请让卖家重新签一条"],
    ["OfferAmountZero", "出价金额必须是大于 0 的 ETH"],
    ["NoOfferToWithdraw", "你在这枚 NFT 上没有可取的报价"],
    ["NothingToWithdraw", "没有可领取的款项"],
    ["FeeTooHigh", "费率超过 MAX_FEE_BPS 硬上限"],
    ["OwnableUnauthorizedAccount", "只有合约 owner 能做这个操作"],
    ["OwnableInvalidOwner", "owner 地址非法（不能是零地址）"],
    ["ZeroAddress", "不允许传零地址"],
    ["PriceZero", "价格必须大于 0"],
    ["IntentPriceZero", "签名里的价格必须大于 0"],
    ["MaxSupplyReached", "已达到铸造上限"],
    ["PublicMintDisabled", "公开铸造当前是关闭状态"],
    ["EmptyTokenURI", "tokenURI 不能为空"],
    ["ERC721InsufficientApproval", "ERC721 授权不足"],
    ["ERC721IncorrectOwner", "你不是该 NFT 的 owner"],
    ["ReentrancyGuardReentrantCall", "重入被拦截（这是防护生效，不是故障）"]
  ];
  function explain(e) {
    var raw = (e && (e.shortMessage || e.reason || e.message)) || String(e);
    for (var i = 0; i < ERRMAP.length; i++) {
      if (raw.indexOf(ERRMAP[i][0]) !== -1) return ERRMAP[i][1];
    }
    if (/user rejected|ACTION_REJECTED|denied/i.test(raw)) return "你在钱包里取消了这笔交易";
    if (/insufficient funds/i.test(raw)) return "余额不足以支付 金额 + gas";
    return raw;
  }

  // 统一发交易：等待上链并记日志
  async function send(fn, label, refreshAfter) {
    try {
      log("提交：" + label + "（等待钱包确认…）");
      var tx = await fn();
      log("已上链，哈希 " + link("tx", tx.hash), "s");
      var rc = await tx.wait();
      log(label + " 成功 | 区块 " + rc.blockNumber + " | gas " + rc.gasUsed.toString(), "s");
      if (refreshAfter) await refreshAfter();
      return rc;
    } catch (e) {
      log(label + " 失败：" + explain(e), "e");
      return null;
    }
  }

  // ---------------------------------------------------------------- 初始化

  async function loadAbi() {
    abiNft = await (await fetch("abi/MyNFT.json")).json();
    abiMkt = await (await fetch("abi/SimpleMarket.json")).json();
  }

  async function connect() {
    if (!window.ethereum) {
      log("没有检测到钱包插件。请用带有 Web3 钱包的浏览器打开（应用宝内的 MetaMask、或桌面 MetaMask 扩展）。", "e");
      return;
    }
    try {
      var accs = await window.ethereum.request({ method: "eth_requestAccounts" });
      account = accs[0];
      provider = new E.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();

      var net = await provider.getNetwork();
      if (Number(net.chainId) !== CFG.chainId) {
        $("netPill").className = "pill warn";
        $("netPill").textContent = "网络不符 (" + net.chainId + ")";
        log("当前网络 chainId=" + net.chainId + "，本页只对接 " + CFG.chainName +
            "（" + CFG.chainId + "）。请在钱包里切换，或点下方按钮。", "w");
        if (!await switchNetwork()) return;
      }
      bindContracts();
      $("netPill").className = "pill on";
      $("netPill").textContent = CFG.chainName;
      $("acctPill").textContent = short(account);
      $("btnConnect").textContent = short(account);
      try {
        var savedNft = localStorage.getItem("simplemarket.nft");
        if (savedNft && !$("curNft").value) $("curNft").value = savedNft;
      } catch (_) {}
      if (!$("curNft").value) $("curNft").value = CFG.contracts.MyNFT.address;
      syncAddrInputs();
      log("已连接 " + account, "s");
      await refreshAll();
    } catch (e) {
      log("连接失败：" + explain(e), "e");
    }
  }

  async function switchNetwork() {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + CFG.chainId.toString(16) }]
      });
      provider = new E.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
      log("已切换到 " + CFG.chainName, "s");
      return true;
    } catch (e) {
      log("切换网络失败，请手动在钱包里切到 " + CFG.chainName, "e");
      return false;
    }
  }

  function bindContracts() {
    var naddr = nftAddress();
    nft = new E.Contract(naddr, abiNft, provider);
    market = new E.Contract(CFG.contracts.SimpleMarket.address, abiMkt, provider);
    nftW = new E.Contract(naddr, abiNft, signer);
    marketW = new E.Contract(CFG.contracts.SimpleMarket.address, abiMkt, signer);
  }

  // ---------------------------------------------------------------- 刷新

  async function refreshState() {
    try {
      var feeBps = await market.feeBps();
      var paused = await market.paused();
      var owner = await market.owner();
      var accFees = await market.accumulatedFees();
      var nftPaused = await nft.paused();
      var nftOwner = await nft.owner();
      var rows = [
        ["平台费率", (Number(feeBps) / 100).toFixed(2) + "%  (" + feeBps.toString() + " / 10000)"],
        ["市场状态", paused ? "已暂停（开仓被挡，撤单/提现可用）" : "正常运行"],
        ["市场 owner", short(owner)],
        ["市场代收手续费", E.formatEther(accFees) + " ETH"],
        ["NFT 合约状态", nftPaused ? "已暂停（铸造被挡）" : "正常运行"],
        ["NFT owner", short(nftOwner)]
      ];
      $("stateBox").innerHTML = rows.map(function (r) {
        return "<div>" + r[0] + "</div><div>" + r[1] + "</div>";
      }).join("");
      var a = CFG.contracts;
      $("addrBox").innerHTML =
        "<div>MyNFT</div><div>" + link("address", a.MyNFT.address) + "</div>" +
        "<div>SimpleMarket</div><div>" + link("address", a.SimpleMarket.address) + "</div>";
    } catch (e) { log("刷新状态失败：" + explain(e), "e"); }
  }

  async function refreshNfts() {
    if (!account) return;
    try {
      var bal = await nft.balanceOf(account);
      var approved = await nft.isApprovedForAll(account, CFG.contracts.SimpleMarket.address);
      $("approvePill").className = "pill " + (approved ? "on" : "off");
      $("approvePill").textContent = approved ? "已授权市场" : "未授权";
      $("btnApprove").textContent = approved ? "取消授权" : "授权市场";

      var items = [];
      for (var i = 0; i < Number(bal); i++) {
        var tid = await nft.tokenOfOwnerByIndex(account, i);
        var uri = "";
        try { uri = await nft.tokenURI(tid); } catch (_) {}
        items.push({ id: tid.toString(), uri: uri });
      }
      if (!items.length) {
        $("nftList").innerHTML = '<div class="nft" style="color:var(--dim)">你还没有 NFT，可点「公开铸造一枚」</div>';
        return;
      }
      $("nftList").innerHTML = items.map(function (it) {
        return '<div class="nft" data-id="' + it.id + '">' +
               '<span class="id">#' + it.id + "</span>" +
               '<span class="uri">' + (it.uri || "(无 URI)") + "</span></div>";
      }).join("");
      Array.prototype.forEach.call($("nftList").querySelectorAll(".nft"), function (el) {
        el.onclick = function () {
          Array.prototype.forEach.call($("nftList").querySelectorAll(".nft"), function (x) {
            x.classList.remove("sel");
          });
          el.classList.add("sel");
          var id = el.getAttribute("data-id");
          ["lstToken", "buyToken", "sigToken", "offToken", "actToken"].forEach(function (k) {
            $(k).value = id;
          });
          log("已选中 #" + id + "，已填入各操作框");
        };
      });
    } catch (e) { log("刷新 NFT 失败：" + explain(e), "e"); }
  }

  async function refreshFunds() {
    if (!account) return;
    try {
      var pend = await market.pendingWithdrawals(account);
      var roy = await market.pendingRoyalties(account);
      var accFees = await market.accumulatedFees();
      var rows = [
        ["我的待领款", E.formatEther(pend) + " ETH"],
        ["我的版税（市场代收）", E.formatEther(roy) + " ETH"],
        ["市场累计手续费", E.formatEther(accFees) + " ETH"]
      ];
      $("fundBox").innerHTML = rows.map(function (r) {
        return "<div>" + r[0] + "</div><div>" + r[1] + "</div>";
      }).join("");
    } catch (e) { log("刷新资金失败：" + explain(e), "e"); }
  }

  async function refreshAll() {
    await refreshState();
    await refreshNfts();
    await refreshFunds();
    await refreshMarket();
  }

  // ---------------------------------------------------------------- 挂单 / 购买

  async function doList() {
    if (!need($("lstToken").value, "请填 TokenId")) return;
    var price = E.parseEther($("lstPrice").value || "0");
    if (!need(price > 0n, "价格必须大于 0")) return;
    await send(function () {
      return marketW.list($("lstNft").value, $("lstToken").value, price);
    }, "挂单 #" + $("lstToken").value + " @ " + $("lstPrice").value + " ETH", refreshAll);
  }

  async function doCancel() {
    if (!need($("lstToken").value, "请填 TokenId")) return;
    await send(function () { return marketW.cancel($("lstNft").value, $("lstToken").value); },
      "撤单 #" + $("lstToken").value, refreshAll);
  }

  async function doUpdatePrice() {
    if (!need($("lstToken").value, "请填 TokenId")) return;
    var price = E.parseEther($("lstPrice").value || "0");
    if (!need(price > 0n, "价格必须大于 0")) return;
    await send(function () { return marketW.updatePrice($("lstNft").value, $("lstToken").value, price); },
      "改价 #" + $("lstToken").value + " → " + $("lstPrice").value + " ETH", refreshAll);
  }

  async function doQueryListing() {
    try {
      var r = await market.getListing($("lstNft").value, $("lstToken").value);
      $("listingBox").innerHTML = r[2]
        ? "卖家 " + short(r[0]) + " | 价格 " + E.formatEther(r[1]) + " ETH | 在售中"
        : "当前无挂单";
    } catch (e) { $("listingBox").textContent = "查询失败：" + explain(e); }
  }

  async function doQuote() {
    try {
      var price = E.parseEther($("buyPrice").value || "0");
      var q = await market.quoteWithRoyalty($("buyNft").value, $("buyToken").value, price);
      $("quoteBox").innerHTML =
        "成交价 " + E.formatEther(price) + " ETH<br>" +
        "├ 平台费 " + E.formatEther(q[0]) + "<br>" +
        "├ 版税   " + E.formatEther(q[1]) + " → " + short(q[2]) + "<br>" +
        "└ 卖家实得 " + E.formatEther(q[3]);
    } catch (e) { $("quoteBox").textContent = "预估失败：" + explain(e); }
  }

  async function doBuy() {
    var price = E.parseEther($("buyPrice").value || "0");
    if (!need(price > 0n, "价格必须大于 0")) return;
    await send(function () {
      return marketW.buy($("buyNft").value, $("buyToken").value, { value: price });
    }, "买入 #" + $("buyToken").value + " @ " + $("buyPrice").value + " ETH", refreshAll);
  }

  // ---------------------------------------------------------------- 在售一览

  /* 合约把挂单存在 mapping 里：mapping 本身不可枚举，
   * 想列出来只能遍历 tokenId 0 .. nextTokenId-1 逐个 getListing。
   * 规模小的时候够用；量大了要换成「事件索引 + 链下库」，见 scripts/market-board.js。
   */
  async function refreshMarket() {
    if (!market) { log("请先连接钱包", "e"); return; }
    var pill = $("marketPill");
    pill.className = "pill warn";
    pill.textContent = "扫描中…";
    try {
      var top = Number(await nft.nextTokenId());
      var rows = [];
      for (var i = 0; i < top; i++) {
        var r = await market.getListing(nftAddress(), i);
        if (r[2]) rows.push({ tokenId: String(i), seller: r[0], price: r[1] });
      }
      renderMarket(rows, top);
    } catch (e) {
      pill.className = "pill err";
      pill.textContent = "刷新失败";
      log("刷新在售失败：" + explain(e), "e");
    }
  }

  function renderMarket(rows, top) {
    var box = $("marketBoard");
    var pill = $("marketPill");
    pill.className = "pill " + (rows.length ? "on" : "off");
    pill.textContent = rows.length ? rows.length + " 笔在售" : "暂无在售";

    if (!rows.length) {
      box.innerHTML = '<div class="nft" style="color:var(--dim)">' +
        (top === 0
          ? "这个 NFT 合约还没铸造过任何代币（nextTokenId = 0）"
          : "扫过 tokenId 0 .. " + (top - 1) + "，当前没有在售挂单") +
        "</div>";
      return;
    }

    box.innerHTML = rows.map(function (r) {
      var mine = account && r.seller.toLowerCase() === account.toLowerCase();
      return '<div class="mrow" data-id="' + r.tokenId + '"' +
             ' data-price="' + E.formatEther(r.price) + '">' +
             '<span class="id">#' + r.tokenId + "</span>" +
             "<span>" + short(r.seller) +
             (mine ? ' <span class="pill on">我的</span>' : "") + "</span>" +
             "<span>" + E.formatEther(r.price) + " ETH</span>" +
             '<span class="op">' +
             (mine
               ? '<button class="small ghost" data-act="cancel">撤单</button>'
               : '<button class="small" data-act="buy">买入</button>') +
             '<button class="small ghost" data-act="fill">填入购买框</button>' +
             "</span></div>";
    }).join("");

    Array.prototype.forEach.call(box.querySelectorAll(".mrow button"), function (btn) {
      btn.onclick = function () {
        var row = btn.parentNode.parentNode;
        var id = row.getAttribute("data-id");
        var price = row.getAttribute("data-price");
        var act = btn.getAttribute("data-act");
        // 三个动作都先把这行填进「购买」表单，保证页面上看到的和发出去的一致
        $("buyToken").value = id;
        $("buyPrice").value = price;
        if (act === "fill") {
          log("已把 #" + id + "（" + price + " ETH）填入购买框");
          doQuote();
        } else if (act === "buy") {
          doBuy();
        } else {
          $("lstToken").value = id;
          doCancel();
        }
      };
    });
  }

  // ---------------------------------------------------------------- EIP-712

  var TYPES = {
    ListingIntent: [
      { name: "nftContract", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "price", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" }
    ]
  };

  function domainOf() {
    return {
      name: CFG.eip712.name, version: CFG.eip712.version,
      chainId: CFG.chainId, verifyingContract: CFG.contracts.SimpleMarket.address
    };
  }

  async function doSign() {
    if (!need($("sigToken").value, "请填 TokenId")) return;
    var price = E.parseEther($("sigPrice").value || "0");
    if (!need(price > 0n, "价格必须大于 0")) return;
    try {
      var nonce = await market.listingNonces(account);
      var deadline = Math.floor(Date.now() / 1000) + Number($("sigMins").value || 60) * 60;
      var intent = {
        nftContract: nftAddress(),
        tokenId: $("sigToken").value,
        price: price.toString(),
        deadline: deadline,
        nonce: nonce.toString()
      };
      log("请求签名（这一步不花 gas，也不会上链）…");
      var sig = await signer.signTypedData(domainOf(), TYPES, intent);
      var payload = { intent: intent, seller: account, signature: sig };
      $("sigOut").value = JSON.stringify(payload, null, 2);
      log("签名已生成 | nonce=" + intent.nonce + " | 过期时间 " + new Date(deadline * 1000).toLocaleString(), "s");
      log("把上面这段 JSON 发给买家，对方在「用签名成交」里粘贴即可。", "i");
    } catch (e) { log("签名失败：" + explain(e), "e"); }
  }

  async function doBumpNonce() {
    await send(function () { return marketW.incrementNonce(); }, "作废全部旧签名（nonce +1）", refreshAll);
  }

  async function doParseSig() {
    try {
      var p = JSON.parse($("sigIn").value);
      var it = p.intent;
      var nonce = await market.listingNonces(p.seller);
      var expired = Math.floor(Date.now() / 1000) > Number(it.deadline);
      var q = await market.quoteWithRoyalty(it.nftContract, it.tokenId, it.price);
      $("fulfillBox").innerHTML =
        "NFT " + short(it.nftContract) + " #" + it.tokenId + "<br>" +
        "卖家 " + short(p.seller) + " | 价格 " + E.formatEther(it.price) + " ETH<br>" +
        "nonce " + it.nonce + "（链上当前 " + nonce.toString() + "）" +
        (it.nonce == nonce.toString() ? " ✓" : " ✗ 不匹配") + "<br>" +
        "deadline " + new Date(Number(it.deadline) * 1000).toLocaleString() +
        (expired ? " ✗ 已过期" : " ✓") + "<br>" +
        "分账：平台费 " + E.formatEther(q[0]) + " / 版税 " + E.formatEther(q[1]) +
        " / 卖家得 " + E.formatEther(q[3]);
    } catch (e) { $("fulfillBox").textContent = "解析失败：" + explain(e); }
  }

  async function doFulfill() {
    try {
      var p = JSON.parse($("sigIn").value);
      await send(function () {
        return marketW.fulfillListing(p.intent, p.seller, p.signature, { value: p.intent.price });
      }, "签名成交 #" + p.intent.tokenId + " @ " + E.formatEther(p.intent.price) + " ETH", refreshAll);
    } catch (e) { log("成交失败：" + explain(e), "e"); }
  }

  // ---------------------------------------------------------------- 出价

  async function doOffer() {
    var amt = E.parseEther($("offAmount").value || "0");
    if (!need(amt > 0n, "出价必须大于 0")) return;
    await send(function () {
      return marketW.makeOffer($("offNft").value, $("offToken").value, { value: amt });
    }, "出价 #" + $("offToken").value + " " + $("offAmount").value + " ETH", refreshAll);
  }

  async function doWithdrawOffer() {
    await send(function () { return marketW.withdrawOffer($("offNft").value, $("offToken").value); },
      "取回出价 #" + $("offToken").value, refreshAll);
  }

  async function doQueryOffer() {
    try {
      var who = $("offBidder").value || account;
      var r = await market.getOffer($("offNft").value, $("offToken").value, who);
      $("offerBox").innerHTML = Number(r[0]) > 0
        ? short(who) + " 的出价：" + E.formatEther(r[0]) + " ETH"
        : short(who) + " 在这枚 NFT 上没有出价";
    } catch (e) { $("offerBox").textContent = "查询失败：" + explain(e); }
  }

  async function doAcceptOffer() {
    await send(function () {
      return marketW.acceptOffer($("actNft").value, $("actToken").value, $("actBidder").value);
    }, "接受 " + short($("actBidder").value) + " 对 #" + $("actToken").value + " 的出价", refreshAll);
  }

  async function doRejectOffer() {
    await send(function () {
      return marketW.rejectOffer($("actNft").value, $("actToken").value, $("actBidder").value);
    }, "拒绝 " + short($("actBidder").value) + " 对 #" + $("actToken").value + " 的出价", refreshAll);
  }

  // ---------------------------------------------------------------- 资金 / 铸造 / 授权

  async function doApprove() {
    var approved = await nft.isApprovedForAll(account, CFG.contracts.SimpleMarket.address);
    await send(function () {
      return nftW.setApprovalForAll(CFG.contracts.SimpleMarket.address, !approved);
    }, approved ? "取消市场授权" : "授权市场操作我的 NFT", refreshNfts);
  }

  async function doMint() {
    var uri = prompt("给这枚 NFT 一个 tokenURI（可留空用默认值）：", "ipfs://demo");
    if (uri === null) return;
    try {
      var enabled = await nft.publicMintEnabled();
      if (!enabled) log("公开铸造当前是关闭状态，需要 owner 先打开 setPublicMintEnabled(true)", "w");
    } catch (_) {}
    await send(function () { return nftW.publicMint(uri || "ipfs://demo"); }, "公开铸造一枚 NFT", refreshAll);
  }

  async function doWithdrawPending() {
    await send(function () { return marketW.withdrawPendingFunds(); }, "领回待领款", refreshFunds);
  }
  async function doWithdrawRoyalty() {
    await send(function () { return marketW.withdrawRoyalties(); }, "领回版税", refreshFunds);
  }
  async function doWithdrawFees() {
    await send(function () { return marketW.withdrawFees(account); }, "提取平台费", refreshFunds);
  }

  async function doCopySig() {
    try {
      await navigator.clipboard.writeText($("sigOut").value);
      log("签名 JSON 已复制到剪贴板", "s");
    } catch (e) { log("复制失败，请手动全选复制", "w"); }
  }

  // ---------------------------------------------------------------- 绑定

  function bind() {
    $("btnConnect").onclick = connect;

    if ($("curNft")) {
      $("curNft").addEventListener("change", function () {
        var v = $("curNft").value.trim();
        try { localStorage.setItem("simplemarket.nft", v); } catch (_) {}
        syncAddrInputs();
        if (provider) { bindContracts(); refreshAll(); }
        log("当前 NFT 合约已切换为 " + nftAddress(), "s");
      });
    }

    $("btnRefreshNft").onclick = refreshNfts;
    $("btnApprove").onclick = doApprove;
    $("btnMint").onclick = doMint;

    $("btnList").onclick = doList;
    $("btnCancel").onclick = doCancel;
    $("btnUpdatePrice").onclick = doUpdatePrice;
    $("btnQueryListing").onclick = doQueryListing;

    $("btnQuote").onclick = doQuote;
    $("btnBuy").onclick = doBuy;

    $("btnRefreshMarket").onclick = refreshMarket;

    $("btnSign").onclick = doSign;
    $("btnCopySig").onclick = doCopySig;
    $("btnBumpNonce").onclick = doBumpNonce;
    $("btnParseSig").onclick = doParseSig;
    $("btnFulfill").onclick = doFulfill;

    $("btnOffer").onclick = doOffer;
    $("btnWithdrawOffer").onclick = doWithdrawOffer;
    $("btnQueryOffer").onclick = doQueryOffer;
    $("btnAcceptOffer").onclick = doAcceptOffer;
    $("btnRejectOffer").onclick = doRejectOffer;

    $("btnWithdrawPending").onclick = doWithdrawPending;
    $("btnWithdrawRoyalty").onclick = doWithdrawRoyalty;
    $("btnWithdrawFees").onclick = doWithdrawFees;

    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on("accountsChanged", function (accs) {
        if (!accs.length) { location.reload(); return; }
        account = accs[0];
        $("acctPill").textContent = short(account);
        log("账户切换为 " + account, "w");
        bindContracts();
        refreshAll();
      });
      window.ethereum.on("chainChanged", function () { location.reload(); });
    }
  }

  // ---------------------------------------------------------------- 启动

  (async function init() {
    log("页面就绪。合约：MyNFT " + short(CFG.contracts.MyNFT.address) +
        " / SimpleMarket " + short(CFG.contracts.SimpleMarket.address));
    log("提示：本页只对接 " + CFG.chainName + "，请先点「连接钱包」。");
    try {
      await loadAbi();
      bind();
    } catch (e) {
      log("ABI 加载失败：" + explain(e) + "（必须通过 http:// 打开本页，不能直接双击 html 文件）", "e");
    }
  })();
})();
