// Tests for the pure math functions in read-cl-position.js.
// Run with: node --test scripts/read-cl-position.test.js

import { test } from "node:test";
import assert from "assert/strict";
import {
  tickToSqrtPriceX96,
  calculateAmounts,
  formatAmount,
  sqrtPriceX96ToPrice,
  tickToPrice,
} from "./read-cl-position.js";

const Q96 = 2n ** 96n;

// ─── tickToSqrtPriceX96 ───────────────────────────────────────────────────────

test("tick 0 produces a value within 0.01% of 2^96", () => {
  const got = tickToSqrtPriceX96(0);
  const diff = got > Q96 ? got - Q96 : Q96 - got;
  assert.ok(diff * 10_000n < Q96, `expected ~${Q96}, got ${got}`);
});

test("higher tick produces higher sqrtPriceX96", () => {
  assert.ok(tickToSqrtPriceX96(200) > tickToSqrtPriceX96(0));
  assert.ok(tickToSqrtPriceX96(1000) > tickToSqrtPriceX96(200));
});

test("negative tick produces lower sqrtPriceX96 than tick 0", () => {
  assert.ok(tickToSqrtPriceX96(-200) < Q96);
  assert.ok(tickToSqrtPriceX96(-200) < tickToSqrtPriceX96(0));
});

test("symmetric: tick N and tick -N are reciprocals (product ≈ 2^192)", () => {
  const pos = tickToSqrtPriceX96(500);
  const neg = tickToSqrtPriceX96(-500);
  // pos * neg / Q96^2 should be ≈ 1, i.e. pos * neg ≈ Q96^2
  const product = pos * neg;
  const expected = Q96 * Q96;
  const diff = product > expected ? product - expected : expected - product;
  // Allow 0.1% relative error
  assert.ok(diff * 1000n < expected, `product ${product} not close to Q96^2 ${expected}`);
});

// ─── calculateAmounts ─────────────────────────────────────────────────────────

test("zero liquidity → zero amounts regardless of price", () => {
  const r = calculateAmounts(0n, Q96, -100, 100);
  assert.equal(r.amount0, 0n);
  assert.equal(r.amount1, 0n);
});

test("out of range below → all token0, no token1", () => {
  // current price at tick -200, position range [200, 400] → price is below range
  const sqrtC = tickToSqrtPriceX96(-200);
  const r = calculateAmounts(1_000_000n, sqrtC, 200, 400);
  assert.ok(r.amount0 > 0n, "expected token0 > 0");
  assert.equal(r.amount1, 0n);
});

test("out of range above → all token1, no token0", () => {
  // current price at tick 600, position range [200, 400] → price is above range
  const sqrtC = tickToSqrtPriceX96(600);
  const r = calculateAmounts(1_000_000n, sqrtC, 200, 400);
  assert.equal(r.amount0, 0n);
  assert.ok(r.amount1 > 0n, "expected token1 > 0");
});

test("in range → both tokens non-zero", () => {
  // current price at tick 300, position range [200, 400]
  const sqrtC = tickToSqrtPriceX96(300);
  const r = calculateAmounts(1_000_000n, sqrtC, 200, 400);
  assert.ok(r.amount0 > 0n, "expected token0 > 0");
  assert.ok(r.amount1 > 0n, "expected token1 > 0");
});

test("amounts scale proportionally with liquidity (±1 for integer division)", () => {
  const sqrtC = tickToSqrtPriceX96(300);
  const r1 = calculateAmounts(1_000n, sqrtC, 200, 400);
  const r2 = calculateAmounts(2_000n, sqrtC, 200, 400);
  const absDiff = (a, b) => (a > b ? a - b : b - a);
  assert.ok(absDiff(r2.amount0, r1.amount0 * 2n) <= 1n, `amount0: ${r2.amount0} vs ${r1.amount0 * 2n}`);
  assert.ok(absDiff(r2.amount1, r1.amount1 * 2n) <= 1n, `amount1: ${r2.amount1} vs ${r1.amount1 * 2n}`);
});

test("at lower tick boundary → all token0", () => {
  // price exactly at tickLower → out of range below
  const sqrtC = tickToSqrtPriceX96(200);
  const r = calculateAmounts(1_000_000n, sqrtC, 200, 400);
  assert.equal(r.amount1, 0n);
});

// ─── formatAmount ─────────────────────────────────────────────────────────────

test("formatAmount: zero → '0'", () => {
  assert.equal(formatAmount(0n, 18), "0");
});

test("formatAmount: exactly 1 whole unit (18 decimals)", () => {
  assert.equal(formatAmount(10n ** 18n, 18), "1");
});

test("formatAmount: 1.5 with 18 decimals", () => {
  assert.equal(formatAmount(15n * 10n ** 17n, 18), "1.5");
});

test("formatAmount: 0.1 with 18 decimals", () => {
  assert.equal(formatAmount(10n ** 17n, 18), "0.1");
});

test("formatAmount: trims trailing zeros", () => {
  // 1.50000...0 should become "1.5"
  assert.equal(formatAmount(15n * 10n ** 17n, 18), "1.5");
});

test("formatAmount: 8-decimal BTC, 1 satoshi", () => {
  assert.equal(formatAmount(1n, 8), "0.00000001");
});

test("formatAmount: 8-decimal BTC, 1 whole BTC", () => {
  assert.equal(formatAmount(100_000_000n, 8), "1");
});

// ─── sqrtPriceX96ToPrice ──────────────────────────────────────────────────────

test("sqrtPriceX96 = 2^96, equal decimals → price '1.0'", () => {
  assert.equal(sqrtPriceX96ToPrice(Q96, 18, 18), "1.0");
});

test("sqrtPriceX96 > 2^96, equal decimals → price > 1", () => {
  const price = parseFloat(sqrtPriceX96ToPrice(tickToSqrtPriceX96(1000), 18, 18));
  assert.ok(price > 1, `expected > 1, got ${price}`);
});

test("sqrtPriceX96 < 2^96, equal decimals → price < 1", () => {
  const price = parseFloat(sqrtPriceX96ToPrice(tickToSqrtPriceX96(-1000), 18, 18));
  assert.ok(price > 0 && price < 1, `expected (0,1), got ${price}`);
});

// ─── tickToPrice ──────────────────────────────────────────────────────────────

test("tickToPrice: tick 0, equal decimals → 1", () => {
  assert.equal(parseFloat(tickToPrice(0, 18, 18)), 1);
});

test("tickToPrice: positive tick, equal decimals → > 1", () => {
  assert.ok(parseFloat(tickToPrice(1000, 18, 18)) > 1);
});

test("tickToPrice: negative tick, equal decimals → < 1", () => {
  const p = parseFloat(tickToPrice(-1000, 18, 18));
  assert.ok(p > 0 && p < 1, `expected (0,1), got ${p}`);
});

test("tickToPrice and sqrtPriceX96ToPrice agree within 0.1% for tick 500", () => {
  const tick = 500;
  const p1 = parseFloat(tickToPrice(tick, 18, 18));
  const p2 = parseFloat(sqrtPriceX96ToPrice(tickToSqrtPriceX96(tick), 18, 18));
  const relErr = Math.abs(p1 - p2) / p1;
  assert.ok(relErr < 0.001, `relative error ${relErr} exceeds 0.1%`);
});
