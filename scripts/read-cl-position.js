// CL LP Position Reader — Mezo Mainnet
// Reads Concentrated Liquidity pool positions and stats for a given account.
//
// Setup (run once):
//   npm install ethers@6
//
// Usage:
//   node scripts/read-cl-position.js [account_address]
//
// Defaults to: 0xFC7e6c4b768534167d411a48505aa30F02b38439

import { ethers } from "ethers";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_ACCOUNT = "0xFC7e6c4b768534167d411a48505aa30F02b38439";
const MEZO_CHAIN_ID = 31612n;
const EXPLORER = "https://explorer.mezo.org";

const RPCS = [
  "https://rpc.mezo.org",
  "https://rpc-http.mezo.boar.network",
  "https://mezo.drpc.org",
];

const NPM_ADDRESS     = "0x509Bc221df2B83927c695FA0bb0f5B21053C874c";
const FACTORY_ADDRESS = "0xBB24AF5c6fB88F1d191FA76055e30BF881BeEb79";
const EXPLORER_API    = "https://explorer.mezo.org/api";

const FEE_FROM_TICK_SPACING = {
  1: "0.01%", 10: "0.05%", 50: "0.05%",
  100: "0.05%", 200: "0.30%", 2000: "1.00%",
};

// ─── ABIs ─────────────────────────────────────────────────────────────────────

// Velodrome Slipstream NonfungiblePositionManager.
// Key difference vs Uniswap V3: 5th return field is tickSpacing (int24), not fee (uint24),
// because the Slipstream pool key is (token0, token1, tickSpacing).
const NPM_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)",
];

// Velodrome Slipstream CLPool slot0 — no feeProtocol field (unlike Uniswap V3).
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

// ─── Provider ─────────────────────────────────────────────────────────────────

async function createProvider() {
  for (const url of RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const net = await provider.getNetwork();
      if (net.chainId === MEZO_CHAIN_ID) return provider;
      console.warn(`  ${url}: wrong chain ID ${net.chainId}, skipping.`);
    } catch {
      console.warn(`  ${url}: connection failed, trying next...`);
    }
  }
  throw new Error(`All RPCs failed. Tried:\n  ${RPCS.join("\n  ")}`);
}

// ─── Token metadata cache ─────────────────────────────────────────────────────

const tokenCache = new Map();

async function getTokenMeta(provider, address) {
  const key = address.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key);
  try {
    const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
    const meta = { symbol, decimals: Number(decimals) };
    tokenCache.set(key, meta);
    return meta;
  } catch {
    const meta = { symbol: "???", decimals: 18 };
    tokenCache.set(key, meta);
    return meta;
  }
}

// ─── BigInt math ──────────────────────────────────────────────────────────────

const Q96 = 2n ** 96n;

// Converts a tick to its sqrtPriceX96 representation (Q64.96 BigInt).
// Uses a Q20 split to preserve float precision for realistic tick ranges
// (covers sqrtRatio up to ~8.6e9, i.e., BTC prices up to ~$3 billion).
function tickToSqrtPriceX96(tick) {
  const sqrtRatio = Math.pow(1.0001, tick / 2);
  const Q20 = 1_048_576; // 2^20
  const scaled = sqrtRatio * Q20;
  if (scaled > Number.MAX_SAFE_INTEGER) {
    // For extreme ticks: use integer part only (imprecise but won't crash)
    return BigInt(Math.round(sqrtRatio)) * Q96;
  }
  return BigInt(Math.round(scaled)) * (2n ** 76n);
}

// Returns token amounts for a position given its liquidity and price bounds.
function calculateAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper) {
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n };

  const sqrtA = tickToSqrtPriceX96(tickLower);
  const sqrtB = tickToSqrtPriceX96(tickUpper);
  const lo = sqrtA < sqrtB ? sqrtA : sqrtB;
  const hi = sqrtA < sqrtB ? sqrtB : sqrtA;
  const sqrtC = sqrtPriceX96;

  if (sqrtC <= lo) {
    // Out of range below: all token0, no token1
    return { amount0: (liquidity * (hi - lo) * Q96) / (lo * hi), amount1: 0n };
  }
  if (sqrtC >= hi) {
    // Out of range above: all token1, no token0
    return { amount0: 0n, amount1: (liquidity * (hi - lo)) / Q96 };
  }
  // In range: both tokens
  return {
    amount0: (liquidity * (hi - sqrtC) * Q96) / (hi * sqrtC),
    amount1: (liquidity * (sqrtC - lo)) / Q96,
  };
}

// Formats a raw BigInt token amount with the given decimal places.
function formatAmount(raw, decimals) {
  if (raw <= 0n) return "0";
  const divisor = 10n ** BigInt(decimals);
  const intPart = raw / divisor;
  const fracPart = raw % divisor;
  const fracStr = fracPart.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${intPart}.${fracStr}` : `${intPart}`;
}

// Returns price of token0 in terms of token1 as a human-readable string.
// price_human = (sqrtPriceX96 / 2^96)^2 × 10^decimals0 / 10^decimals1
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
  const adj0 = 10n ** BigInt(decimals0);
  const adj1 = 10n ** BigInt(decimals1);
  const num = sqrtPriceX96 * sqrtPriceX96 * adj0;
  const den = Q96 * Q96 * adj1;
  const intPart = num / den;
  const rem = num % den;
  const fracScaled = (rem * 100_000_000n) / den; // 8 decimal places
  const fracStr = fracScaled.toString().padStart(8, "0").replace(/0+$/, "") || "0";
  return `${intPart}.${fracStr}`;
}

// Converts a tick to a human-readable price string.
function tickToPrice(tick, decimals0, decimals1) {
  const priceRaw = Math.pow(1.0001, tick);
  const adjusted = (priceRaw * 10 ** decimals0) / 10 ** decimals1;
  if (adjusted === 0) return "0";
  if (adjusted < 1e-6) return adjusted.toExponential(4);
  return parseFloat(adjusted.toPrecision(6)).toString();
}

// ─── Position display ─────────────────────────────────────────────────────────

async function printPosition(provider, npm, tokenId, label) {
  let pos;
  try {
    pos = await npm.positions(tokenId);
  } catch (err) {
    console.log(`  [#${tokenId}] Could not fetch: ${err.message}`);
    return;
  }

  const { token0, token1, tickSpacing, tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1 } = pos;

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(provider, token0),
    getTokenMeta(provider, token1),
  ]);

  const fee = FEE_FROM_TICK_SPACING[Number(tickSpacing)] ?? `tickSpacing=${tickSpacing}`;

  let poolAddress = null;
  let sqrtPriceX96 = null;
  let currentTick = null;
  let poolLiquidity = null;

  try {
    const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
    poolAddress = await factory.getPool(token0, token1, tickSpacing);
  } catch (err) {
    console.log(`  Warning: pool lookup failed: ${err.message}`);
  }

  const poolFound = poolAddress && poolAddress !== ethers.ZeroAddress;

  if (poolFound) {
    try {
      const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
      const [s0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
      sqrtPriceX96 = s0.sqrtPriceX96;
      currentTick = Number(s0.tick);
      poolLiquidity = liq;
    } catch (err) {
      console.log(`  Warning: could not fetch pool state: ${err.message}`);
    }
  }

  const inRange = currentTick !== null
    ? currentTick >= Number(tickLower) && currentTick < Number(tickUpper)
    : null;

  const statusStr = inRange === null ? "UNKNOWN"
    : inRange ? "IN RANGE  ✓" : "OUT OF RANGE  ✗";

  const priceLo = tickToPrice(Number(tickLower), meta0.decimals, meta1.decimals);
  const priceHi = tickToPrice(Number(tickUpper), meta0.decimals, meta1.decimals);
  const currentPriceStr = sqrtPriceX96
    ? sqrtPriceX96ToPrice(sqrtPriceX96, meta0.decimals, meta1.decimals)
    : "N/A";

  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtPriceX96 !== null && liquidity > 0n) {
    ({ amount0, amount1 } = calculateAmounts(liquidity, sqrtPriceX96, Number(tickLower), Number(tickUpper)));
  }

  const sym0 = meta0.symbol.padEnd(6);
  const sym1 = meta1.symbol.padEnd(6);
  const heading = label ? `--- Position #${tokenId} (${label}) ---` : `--- Position #${tokenId} ---`;

  console.log(`\n${heading}`);
  console.log(`Pool:          ${poolFound ? poolAddress : "unknown"} (${meta0.symbol}/${meta1.symbol}, ${fee})`);
  if (poolFound) console.log(`Explorer:      ${EXPLORER}/address/${poolAddress}`);
  console.log(`Status:        ${statusStr}`);
  console.log(`Price Range:   ${priceLo} → ${priceHi}  ${meta1.symbol}/${meta0.symbol}`);
  console.log(`Current Price: ${currentPriceStr}  ${meta1.symbol}/${meta0.symbol}`);
  console.log(`Tick Range:    ${tickLower} → ${tickUpper}  (current: ${currentTick ?? "N/A"})`);
  console.log(`Liquidity:     ${liquidity}`);
  if (poolLiquidity !== null) console.log(`Pool Liquidity:${poolLiquidity}`);
  console.log(`Token Amounts:`);
  console.log(`  ${sym0}  ${formatAmount(amount0, meta0.decimals)}`);
  console.log(`  ${sym1}  ${formatAmount(amount1, meta1.decimals)}`);
  console.log(`Pending Fees:`);
  console.log(`  ${sym0}  ${formatAmount(tokensOwed0, meta0.decimals)}`);
  console.log(`  ${sym1}  ${formatAmount(tokensOwed1, meta1.decimals)}`);
  if (label === "staked") {
    console.log(`  (Note: staked positions earn fees via the gauge; tokensOwed above may be 0)`);
  }
}

// ─── Unstaked positions ───────────────────────────────────────────────────────

async function readPositions(provider, account, npm) {
  console.log("\n=== Unstaked Positions ===");

  let balance;
  try {
    balance = await npm.balanceOf(account);
  } catch (err) {
    console.log(`Error: ${err.message}`);
    return;
  }

  if (balance === 0n) {
    console.log("No unstaked positions found.");
    return;
  }

  console.log(`Found ${balance} position(s)`);

  const indices = Array.from({ length: Number(balance) }, (_, i) => BigInt(i));
  const tokenIds = await Promise.all(
    indices.map((i) => npm.tokenOfOwnerByIndex(account, i).catch(() => null))
  );

  for (const tokenId of tokenIds) {
    if (tokenId !== null) await printPosition(provider, npm, tokenId, null);
  }
}

// ─── Staked positions ─────────────────────────────────────────────────────────

// Uses the Blockscout explorer API to get all ERC-721 transfers involving the account
// for the NPM contract — one HTTP request, no block-range scanning needed.
async function fetchNpmTransfers(account) {
  const url =
    `${EXPLORER_API}?module=account&action=tokennfttx` +
    `&address=${account}&contractaddress=${NPM_ADDRESS}&sort=asc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Blockscout API returned HTTP ${res.status}`);
  const data = await res.json();
  // status "0" with "No transactions found" is a valid empty result
  if (data.status !== "1" && data.message !== "No transactions found") {
    throw new Error(`Blockscout API error: ${data.message ?? JSON.stringify(data)}`);
  }
  return data.result ?? [];
}

// Staked NFTs are owned by the gauge contract, not the user's address.
// Strategy: ask Blockscout for all NPM token transfers involving the account,
// find tokenIds sent FROM the account, then confirm via ownerOf that they're
// still held by another address (i.e. currently staked, not returned or burned).
async function checkStakedPositions(provider, account, npm) {
  console.log("\n=== Staked Positions ===");

  let transfers;
  try {
    transfers = await fetchNpmTransfers(account);
  } catch (err) {
    console.log(`  Warning: ${err.message}`);
    console.log(`  Check manually: ${EXPLORER}/address/${account}?tab=tokens`);
    return;
  }

  // Tokenids the account sent away
  const sentIds = [
    ...new Set(
      transfers
        .filter((t) => t.from.toLowerCase() === account.toLowerCase())
        .map((t) => t.tokenID)
    ),
  ];

  if (sentIds.length === 0) {
    console.log("No staked positions found.");
    return;
  }

  let totalFound = 0;
  for (const tokenIdStr of sentIds) {
    const tokenId = BigInt(tokenIdStr);
    let currentOwner;
    try {
      currentOwner = await npm.ownerOf(tokenId);
    } catch {
      continue; // burned
    }
    if (currentOwner.toLowerCase() === account.toLowerCase()) continue; // returned to account

    totalFound++;
    const shortOwner = `${currentOwner.slice(0, 10)}…`;
    await printPosition(provider, npm, tokenId, `staked @ ${shortOwner}`);
  }

  if (totalFound === 0) {
    console.log("No staked positions found.");
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const account = process.argv[2] || DEFAULT_ACCOUNT;

  console.log("=== CL LP Position Reader — Mezo Mainnet ===");
  console.log(`Account:  ${account}`);
  console.log(`Explorer: ${EXPLORER}/address/${account}`);
  console.log("\nConnecting to Mezo mainnet...");

  const provider = await createProvider();
  const { chainId } = await provider.getNetwork();
  console.log(`Connected  (chain ID: ${chainId})`);

  const npm = new ethers.Contract(NPM_ADDRESS, NPM_ABI, provider);

  await readPositions(provider, account, npm);
  await checkStakedPositions(provider, account, npm);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
