/* Zhodler run-rate engine.
 *
 * ONE projection engine, shared by the dashboard (index.html) and the Scenario
 * Lab (lab.html), so a figure can never be computed two ways. No network, no
 * DOM, no randomness: the same inputs always give the same answer.
 *
 * What it does: starts from what is owned and owed today and moves it forward
 * month by month using only
 *   - loan schedules (payment, balance, months left),
 *   - the money added each month,
 *   - today's rates (yield on stablecoin positions, the Aave borrow rate),
 *   - one stated path for the BTC price (flat by default).
 * The BTC price is the one thing nobody can know, so it is drawn three times:
 * the stated path, and a bad and a good case (the 1-in-10 outcomes on either
 * side, sized from how much BTC has really moved since Aug 2023).
 *
 * Everything is in USD (the database's unit); the pages convert for display.
 */
(function (root) {
'use strict';
const E = {};
E.VERSION = 2;

// ── Measured constants (each says where it comes from) ──────────────────────
// Annualised size of BTC's daily moves, Binance BTC/USDT daily closes,
// 21 Aug 2023 - 18 Nov 2026 (measured 2026-11-18: 0.461; last 365 days 0.442).
E.BTC_VOL = 0.46;
E.BTC_VOL_SOURCE = 'BTC daily price moves, Aug 2023 to Nov 2026';
// 1.2816 standard deviations = the 10th / 90th percentile ("1 in 10").
E.Z_BAND = 1.2816;
// Aave v3 Arbitrum WBTC: extra collateral a liquidator takes on top of the debt repaid.
E.AAVE_LIQ_PENALTY = 0.07;
E.AAVE_LIQ_THRESHOLD_DEFAULT = 0.78;   // used only if the live read is unavailable
// Portuguese house prices: INE index (base 2015 = 100) stood at 280.21 in Q4 2025,
// i.e. +10.9% a year over ten years. Used ONLY in "past growth continues" mode.
E.HOUSE_PAST_GROWTH = 0.109;
E.HOUSE_PAST_SOURCE = 'INE house price index, 2015 to 2025: +10.9% a year';
// Wear on vehicles a few years old (the dashboard's depreciation curve runs
// 6-15% a year for the ages of the vehicles held).
E.VEHICLE_DEPRECIATION = 0.10;
E.BTC_SYMBOLS = ['BTC', 'WBTC', 'CBBTC', 'TBTC', 'BTCB', 'SBTC', 'LBTC', 'RENBTC', 'SOLVBTC', 'UBTC', 'HBTC', '21BTC', 'AWBTC'];

const num = v => (v === null || v === undefined || isNaN(Number(v))) ? 0 : Number(v);

// Annual rate implied by a balance, a fixed monthly payment and the months left.
E.impliedRate = function (balance, payment, months) {
    if (!(balance > 0) || !(payment > 0) || !(months > 0)) return 0;
    if (payment * months <= balance) return 0;          // no interest (or not enough to repay)
    let lo = 1e-9, hi = 1;                              // monthly rate bounds
    for (let i = 0; i < 100; i++) {
        const r = (lo + hi) / 2;
        const pv = payment * (1 - Math.pow(1 + r, -months)) / r;
        if (pv > balance) lo = r; else hi = r;
    }
    return (lo + hi) / 2 * 12;
};

// BTC price in month m on the stated path, shifted by z standard deviations.
E.btcPriceAt = function (state, a, m) {
    const t = m / 12;
    let shock = 1;
    if (a.btcShockPct) {
        const f = Math.min(1, m / (a.btcShockMonths || 12));
        shock = Math.pow(1 + a.btcShockPct / 100, f);   // reaches the shocked level over the shock period, then stays
    }
    const vol = (a.btcVol === undefined || a.btcVol === null) ? E.BTC_VOL : a.btcVol;
    return state.btcPrice * shock * Math.pow(1 + (a.btcGrowth || 0), t) * Math.exp((a.btcZ || 0) * vol * Math.sqrt(t));
};

// BTC price at which the Aave loan is liquidated today.
E.liquidationPrice = function (state) {
    const lt = state.aaveLT || E.AAVE_LIQ_THRESHOLD_DEFAULT;
    return (state.aaveDebt > 0 && state.btcQty > 0) ? state.aaveDebt / (lt * state.btcQty) : null;
};

// Chance that BTC touches a price `dropFrac` below today's (e.g. -0.20) at some
// point within `months`, given its usual swings and the stated yearly growth.
// Standard result for a random walk with drift (reflection principle).
E.touchOdds = function (dropFrac, months, vol, growth) {
    const b = Math.log(1 + dropFrac), t = months / 12, s = (vol === undefined || vol === null) ? E.BTC_VOL : vol;
    if (!(b < 0) || !(t > 0) || !(s > 0)) return b >= 0 ? 1 : 0;
    const mu = Math.log(1 + (growth || 0));
    const phi = x => { // standard normal cumulative distribution (Abramowitz-Stegun 7.1.26, error < 1.5e-7)
        const z = Math.abs(x) / Math.SQRT2, k = 1 / (1 + 0.3275911 * z);
        const erf = 1 - (((((1.061405429 * k - 1.453152027) * k) + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-z * z);
        return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
    };
    const sd = s * Math.sqrt(t);
    return Math.min(1, phi((b - mu * t) / sd) + Math.exp(2 * mu * b / (s * s)) * phi((b + mu * t) / sd));
};

/* simulate(state, a) -> month-by-month series (index 0 = today).
 *
 * state (USD): btcQty, btcPrice, aaveDebt, aaveLT, sleeves, fund, cash, house,
 *              vehicles, otherDebt, loans[{label, balance, payment, monthsLeft, rate?}]
 * a (assumptions, rates as decimals per year):
 *   btcGrowth, btcShockPct, btcShockMonths, btcZ, btcVol,
 *   sleeveYield, borrowRate, fundReturn, houseGrowth, vehicleDep,
 *   newMoneyInvest, newMoneyLoan (USD per month), freedToInvest (default true),
 *   events[{month, type, ...}], horizonMonths,
 *   pools[{name, amount, rate, basis, newPct}]   optional. The stablecoin positions held as
 *       separate pools, each growing at its own rate (basis 'apr' = plain rate, added monthly;
 *       'apy' = the yearly result with compounding already in it). newPct = that pool's share
 *       of the money invested each month. When given, it replaces sleeveYield.
 *       A rate that ends: forMonths (the rate holds for that many months) and thenRate (the
 *       rate afterwards, same basis). Without forMonths the rate holds for the whole run.
 * events:
 *   {type:'cash', amount}            one-off money in (+) or out (-) of the stablecoin positions
 *   {type:'sellBtcRepay', fraction}  sell just enough BTC to repay that share of the Aave loan (default all)
 *   {type:'sellBtc', pct, to}        sell pct% of the BTC held then; proceeds to 'loan' (rest to positions) or 'invest'
 *   {type:'sleevesRepay', amount}    repay Aave from the stablecoin positions (default: as much as possible)
 */
E.simulate = function (state, a) {
    const H = Math.max(1, Math.round(a.horizonMonths || 480));
    const lt = state.aaveLT || E.AAVE_LIQ_THRESHOLD_DEFAULT;
    let qty = num(state.btcQty), debt = num(state.aaveDebt), sleeves = num(state.sleeves), fund = num(state.fund),
        cash = num(state.cash), house = num(state.house), veh = num(state.vehicles);
    const other = num(state.otherDebt);
    const loans = (state.loans || []).map(l => ({
        label: l.label, bal: num(l.balance), pay: num(l.payment),
        r: ((l.rate !== undefined && l.rate !== null) ? num(l.rate) : E.impliedRate(num(l.balance), num(l.payment), num(l.monthsLeft))) / 12,
    }));
    const sy = num(a.sleeveYield) / 12, br = num(a.borrowRate) / 12;
    // Pools are fitted to what is really held: amounts above it are scaled down
    // (money is never invented) and whatever is left over sits in a last pool
    // earning nothing. The same goes for shares of new money above / below 100%.
    let pools = null;
    if (Array.isArray(a.pools)) {
        pools = a.pools.map(p => {
            const until = Math.round(num(p.forMonths)), ends = until >= 1;
            return { name: String(p.name || ''), idle: false, bal: Math.max(0, num(p.amount)), f: E.poolMonthlyFactor(p), share: Math.max(0, num(p.newPct)) / 100,
                     until: ends ? until : Infinity, f2: ends ? E.poolMonthlyFactor({ rate: p.thenRate, basis: p.basis }) : 1 };
        });
        const asked = pools.reduce((t, p) => t + p.bal, 0), shares = pools.reduce((t, p) => t + p.share, 0);
        if (asked > sleeves) pools.forEach(p => { p.bal *= sleeves / asked; });
        if (shares > 1) pools.forEach(p => { p.share /= shares; });
        pools.push({ name: '', idle: true, bal: Math.max(0, sleeves - asked), f: 1, share: Math.max(0, 1 - shares), until: Infinity, f2: 1 });
    }
    const poolSum = () => pools.reduce((t, p) => t + p.bal, 0);
    const fg = Math.pow(1 + num(a.fundReturn), 1 / 12), hg = Math.pow(1 + num(a.houseGrowth), 1 / 12), vd = Math.pow(1 - num(a.vehicleDep), 1 / 12);
    const events = a.events || [];
    let freed = 0;
    const out = { pot: [], netWorth: [], btcValue: [], btcPrice: [], btcQty: [], sleeves: [], aaveDebt: [], tradfiDebt: [],
                  events: [], liqMonth: null, aaveClearMonth: debt > 0 ? null : 0, shortfall: 0 };
    const snap = m => {
        const p = E.btcPriceAt(state, a, m), btcV = qty * p;
        const tl = loans.reduce((s, l) => s + l.bal, 0);
        const pot = btcV + sleeves + fund - debt;
        out.btcPrice.push(p); out.btcQty.push(qty); out.btcValue.push(btcV); out.sleeves.push(sleeves);
        out.aaveDebt.push(debt); out.tradfiDebt.push(tl + other);
        out.pot.push(pot); out.netWorth.push(pot + cash + house + veh - tl - other);
    };
    // Money into (+) or out of (-) the positions. In: split by each pool's share
    // of new money. Out: taken from every pool in proportion to its size.
    const move = x => {
        if (!pools) { sleeves += x; return; }
        if (x >= 0) pools.forEach(p => { p.bal += x * p.share; });
        else {
            const have = poolSum(), k = have > 0 ? Math.min(1, -x / have) : 0;
            pools.forEach(p => { p.bal *= 1 - k; });
            if (-x > have) out.shortfall += -x - have;
        }
        sleeves = poolSum();
    };
    const cleared = m => { if (debt < 0.005) { debt = 0; if (out.aaveClearMonth === null) { out.aaveClearMonth = m; out.events.push({ month: m, type: 'aaveCleared' }); } } };
    snap(0);
    for (let m = 1; m <= H; m++) {
        const p = E.btcPriceAt(state, a, m);
        // 1. rates and wear
        if (pools) { pools.forEach(p => { p.bal *= m <= p.until ? p.f : p.f2; }); sleeves = poolSum(); } else sleeves *= 1 + sy;
        fund *= fg; debt *= 1 + br; house *= hg; veh *= vd;
        // 2. bank loans follow their schedule; a finished loan frees its payment
        let freedNow = 0;                              // payments that end THIS month are free from next month on
        loans.forEach(l => {
            if (l.bal <= 0) return;
            const interest = l.bal * l.r;
            l.bal -= Math.min(l.bal, Math.max(0, l.pay - interest));
            if (l.bal <= 0.005) {
                l.bal = 0;
                if (a.freedToInvest !== false) freedNow += l.pay;
                out.events.push({ month: m, type: 'loanPaid', label: l.label });
            }
        });
        // 3. new money: part repays the Aave loan (until it is gone), the rest is invested
        let invest = num(a.newMoneyInvest) + freed;
        freed += freedNow;
        const toLoan = num(a.newMoneyLoan);
        if (debt > 0 && toLoan > 0) { const pay = Math.min(debt, toLoan); debt -= pay; invest += toLoan - pay; }
        else invest += toLoan;
        move(invest);
        // 4. one-off events
        events.forEach(ev => {
            if (ev.month !== m) return;
            if (ev.type === 'cash') move(num(ev.amount));
            else if (ev.type === 'sellBtcRepay') {
                const q = Math.min(qty, debt * (ev.fraction === undefined ? 1 : num(ev.fraction)) / p);
                qty -= q; debt -= q * p;
            } else if (ev.type === 'sellBtc') {
                const q = Math.min(qty, qty * num(ev.pct) / 100);
                let cashIn = q * p; qty -= q;
                if (ev.to === 'loan') { const pay = Math.min(debt, cashIn); debt -= pay; cashIn -= pay; }
                move(cashIn);
            } else if (ev.type === 'sleevesRepay') {
                const pay = Math.max(0, Math.min(debt, sleeves, ev.amount === undefined ? Infinity : num(ev.amount)));
                move(-pay); debt -= pay;
            }
            out.events.push({ month: m, type: ev.type });
        });
        if (sleeves < 0) { out.shortfall += -sleeves; sleeves = 0; }   // a one-off bigger than the positions: the gap is reported, not hidden
        cleared(m);
        // 5. liquidation: the loan is too large for the BTC behind it. BTC is sold
        //    to repay it, plus the liquidator's penalty.
        if (debt > 0 && debt >= lt * qty * p) {
            const q = Math.min(qty, debt * (1 + E.AAVE_LIQ_PENALTY) / p);
            debt = Math.max(0, debt - q * p / (1 + E.AAVE_LIQ_PENALTY));
            qty -= q;
            if (out.liqMonth === null) { out.liqMonth = m; out.events.push({ month: m, type: 'liquidated', price: p }); }
            if (qty <= 1e-9) debt = 0;          // nothing left behind the loan
            cleared(m);
        }
        snap(m);
    }
    out.loans = loans.map(l => ({ label: l.label, rate: l.r * 12 }));
    out.pools = pools ? pools.map(p => ({ name: p.name, idle: p.idle, balance: p.bal })) : null;   // balances at the end
    return out;
};

/* project(state, a, plan) -> the stated path plus the bad and good BTC cases.
 * plan: { fireNumber (USD today), inflation (decimal/yr), retMonth } */
E.project = function (state, a, plan) {
    const run = z => E.simulate(state, Object.assign({}, a, { btcZ: z }));
    const mid = run(0), low = run(-E.Z_BAND), high = run(E.Z_BAND);
    const H = mid.pot.length - 1;
    const fireNumber = num(plan && plan.fireNumber), infl = num(plan && plan.inflation);
    const target = m => fireNumber * Math.pow(1 + infl, m / 12);
    const firstAbove = (arr, fn) => { for (let m = 0; m <= H; m++) if (arr[m] >= fn(m)) return m; return null; };
    const retMonth = Math.min(H, Math.max(0, Math.round(num(plan && plan.retMonth))));
    const res = { mid, low, high, H, retMonth, target,
        fire: fireNumber > 0 ? { mid: firstAbove(mid.pot, target), low: firstAbove(low.pot, target), high: firstAbove(high.pot, target) } : null,
        atRet: { mid: mid.pot[retMonth], low: low.pot[retMonth], high: high.pot[retMonth], target: target(retMonth) },
    };
    // When each level is first reached (series: 'pot' or 'netWorth').
    res.milestones = (levels, series) => levels.map(lv => {
        const s = series || 'pot', flat = () => lv;
        return { level: lv, mid: firstAbove(mid[s], flat), low: firstAbove(low[s], flat), high: firstAbove(high[s], flat) };
    });
    return res;
};

// Monthly new money needed for the stated path to reach the FIRE number by
// retirement. Returns the TOTAL per month (invest + loan), or null if even
// `cap` a month is not enough.
E.solveSaving = function (state, a, plan, cap) {
    const fireNumber = num(plan.fireNumber), infl = num(plan.inflation), rm = Math.round(num(plan.retMonth));
    if (!(fireNumber > 0) || !(rm > 0)) return null;
    const goal = fireNumber * Math.pow(1 + infl, rm / 12);
    const horizon = Math.max(rm, 1);
    const end = extra => E.simulate(state, Object.assign({}, a, { btcZ: 0, horizonMonths: horizon, newMoneyInvest: num(a.newMoneyInvest) + extra })).pot[rm];
    if (end(0) >= goal) return num(a.newMoneyInvest) + num(a.newMoneyLoan);
    let lo = 0, hi = cap || 100000;
    if (end(hi) < goal) return null;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (end(mid) >= goal) hi = mid; else lo = mid; }
    return num(a.newMoneyInvest) + num(a.newMoneyLoan) + hi;
};

// BTC growth per year needed for the stated path to reach the FIRE number by
// retirement, everything else unchanged. Returns a decimal, or null if out of range.
E.solveBtcGrowth = function (state, a, plan) {
    const fireNumber = num(plan.fireNumber), infl = num(plan.inflation), rm = Math.round(num(plan.retMonth));
    if (!(fireNumber > 0) || !(rm > 0) || !(state.btcQty > 0)) return null;
    const goal = fireNumber * Math.pow(1 + infl, rm / 12);
    const end = g => E.simulate(state, Object.assign({}, a, { btcZ: 0, horizonMonths: rm, btcGrowth: g, btcShockPct: 0 })).pot[rm];
    let lo = -0.5, hi = 5;
    if (end(hi) < goal) return null;
    if (end(lo) >= goal) return lo;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (end(mid) >= goal) hi = mid; else lo = mid; }
    return hi;
};

/* buildState(src) — turn the dashboard's own data into the engine's starting point.
 * src: { bootstrap (dashboard_bootstrap), manualAssets (manual_assets_list),
 *        loanDetails (loan_details_list), eurUsd, aave (live read or null) }
 * Also returns `notes`: one line per input saying where it came from. */
E.buildState = function (src) {
    const b = src.bootstrap || {}, hs = Array.isArray(b.holdings) ? b.holdings : [];
    const fx = num(src.eurUsd) || 1, aave = src.aave || null;
    const isBtc = h => E.BTC_SYMBOLS.includes(String(h.asset || '').toUpperCase());
    const st = { btcQty: 0, btcPrice: num((b.btc || {}).price_usd), aaveDebt: 0, aaveLT: E.AAVE_LIQ_THRESHOLD_DEFAULT,
                 sleeves: 0, fund: 0, cash: 0, house: 0, vehicles: 0, otherDebt: 0, loans: [], sleeveParts: [] };
    st.btcQty = num((b.btc || {}).holdings);
    hs.forEach(h => {
        const v = num(h.usd_value), manual = h.protocol === 'manual';
        if (h.position_type === 'borrow') {
            if (!manual && ['defi_wallet', 'cex'].includes(h.account_type)) st.aaveDebt += Math.abs(v);
            return;                                    // manual loans are handled below from manualAssets
        }
        if (!manual && h.scope_class === 'crypto') {
            if (isBtc(h)) return;                      // BTC is carried as quantity x price
            if (v > 0) { st.sleeves += v; st.sleeveParts.push({ protocol: h.protocol || 'wallet', asset: h.asset, value: v }); }
            return;
        }
        if (manual) {
            if (h.account_type === 'real_estate') st.house += v;
            else if (['motorbike', 'vehicle'].includes(h.account_type)) st.vehicles += v;
            else if (h.account_type === 'bank') st.cash += v;
            else st.fund += v;                         // manual investments (fund, portfolio)
        } else if (v > 0) st.fund += v;                // priced portfolios outside the crypto scope
    });
    if (aave && aave.liqThreshold > 0) st.aaveLT = aave.liqThreshold;
    // Bank loans: balance from manual_assets_list (native currency), schedule from loan_details_list.
    const details = {};
    (src.loanDetails || []).forEach(d => { details[String(d.label).toLowerCase()] = d; });
    (src.manualAssets || []).filter(x => x.kind === 'loan').forEach(x => {
        const eur = x.currency === 'EUR', k = eur ? fx : 1;
        const balNative = (eur && x.original_value !== null && x.original_value !== undefined) ? Math.abs(num(x.original_value)) : Math.abs(num(x.value));
        const balUsd = eur ? balNative * fx : Math.abs(num(x.value));
        const d = details[String(x.label).toLowerCase()];
        const pay = d ? num(d.monthly_payment) : 0;
        let left = d ? num(d.remaining_months) : 0;
        if (d && left > 0 && d.updated_at) {           // months typed once and never counted down: take off the months since
            const u = new Date(d.updated_at), now = src.now ? new Date(src.now) : new Date();
            if (!isNaN(u.getTime())) left -= Math.max(0, (now.getFullYear() - u.getFullYear()) * 12 + (now.getMonth() - u.getMonth()));
        }
        if (pay > 0 && left > 0) {
            const rate = (d.interest_rate_pct !== null && d.interest_rate_pct !== undefined) ? num(d.interest_rate_pct) / 100 : E.impliedRate(balNative, pay, left);
            st.loans.push({ label: x.label, balance: balUsd, payment: pay * k, monthsLeft: left, rate,
                            rateSource: (d.interest_rate_pct !== null && d.interest_rate_pct !== undefined) ? 'typed' : 'implied' });
        } else st.otherDebt += balUsd;                 // no schedule on record: held flat
    });
    return st;
};

// One name per platform, so a typed "Morpho Clearstar" meets the position "Morpho".
E.platformFamily = function (n) {
    const s = String(n || '').toLowerCase();
    return s.includes('pendle') ? 'pendle' : s.includes('morpho') ? 'morpho' : s.includes('aave') ? 'aave' : s.includes('hyperliquid') ? 'hyperliquid' : s;
};

// A pool's rate as a monthly growth factor, and as a plain yearly rate (APR).
E.poolMonthlyFactor = function (p) {
    const r = Math.max(-0.99, num(p && p.rate));
    return (p && p.basis === 'apy') ? Math.pow(1 + r, 1 / 12) : 1 + r / 12;
};
E.poolApr = function (p) { return (E.poolMonthlyFactor(p) - 1) * 12; };

// Today's positions as pools: one per platform, at the rate typed for it. New
// money is shared out in the same proportions (whole percentages adding to 100).
// Balances under $100 or 1% of the total are gathered into one line.
E.defaultPools = function (state, loanSim) {
    const parts = E.sleeveYield(state, loanSim).parts, total = parts.reduce((t, p) => t + p.value, 0);
    const floor = Math.max(100, total * 0.01), pools = [];
    let small = 0, smallW = 0;
    parts.forEach(p => {
        if (p.value >= floor) pools.push({ name: p.protocol === 'wallet' ? 'Wallet (idle)' : p.protocol, src: p.protocol, amount: p.value, rate: p.apr / 100, basis: 'apr' });
        else { small += p.value; smallW += p.value * p.apr; }
    });
    if (small >= 1) pools.push({ name: 'Wallet and small balances', amount: small, rate: smallW / small / 100, basis: 'apr' });
    const sum = pools.reduce((t, p) => t + p.amount, 0);
    let left = 100;
    pools.forEach(p => { p.exact = sum > 0 ? p.amount / sum * 100 : 0; p.newPct = Math.floor(p.exact); left -= p.newPct; });
    pools.slice().sort((x, y) => (y.exact - y.newPct) - (x.exact - x.newPct)).forEach(p => { if (left > 0 && sum > 0) { p.newPct += 1; left -= 1; } });
    pools.forEach(p => { delete p.exact; });
    return pools;
};

// Yield on the stablecoin positions, weighted by where the money sits today.
// loanSim.platforms carries the rates the owner typed in Loan Payoff; a
// position whose platform has no typed rate counts as 0%.
E.sleeveYield = function (state, loanSim) {
    const plats = (loanSim && Array.isArray(loanSim.platforms)) ? loanSim.platforms : [];
    const fam = E.platformFamily;
    const byFam = {};
    plats.forEach(p => { const f = fam(p.name), v = num(p.value), a = num(p.apr); if (!byFam[f]) byFam[f] = { v: 0, va: 0 }; byFam[f].v += v; byFam[f].va += v * a; });
    let total = 0, weighted = 0; const parts = [];
    (state.sleeveParts || []).forEach(sp => {
        const f = byFam[fam(sp.protocol)];
        const apr = (f && f.v > 0) ? f.va / f.v : 0;
        total += sp.value; weighted += sp.value * apr;
        const row = parts.find(x => x.protocol === sp.protocol);
        if (row) row.value += sp.value; else parts.push({ protocol: sp.protocol, value: sp.value, apr });
    });
    return { rate: total > 0 ? weighted / total / 100 : 0, parts: parts.sort((x, y) => y.value - x.value) };
};

// Monthly amounts from the owner's typed contribution plan (Loan Payoff): what goes
// into the positions and what repays the Aave loan.
E.newMoney = function (loanSim) {
    const perMonth = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
    let invest = 0, loan = 0;
    ((loanSim && loanSim.contributions) || []).forEach(c => {
        const k = perMonth[c.frequency]; if (!k) return;
        if (c.target === 'loan') loan += num(c.amount) * k; else invest += num(c.amount) * k;
    });
    return { invest, loan };
};

// BTC's own growth rate since tracking began (from the dashboard's price baselines).
E.btcPastGrowth = function (bootstrap) {
    const b = (bootstrap || {}).btc || {}, base = (b.price_baselines || {}).tracking_start_price_usd;
    const start = ((bootstrap || {}).metrics || {}).tracking_start_date, days = num(((bootstrap || {}).metrics || {}).days_tracked);
    if (!(num(base) > 0) || !(num(b.price_usd) > 0) || !(days > 30)) return null;
    return { rate: Math.pow(num(b.price_usd) / num(base), 365 / days) - 1, since: start, from: num(base), to: num(b.price_usd) };
};

/* defaultAssumptions(src, state, mode)
 * mode 'flat' = "if nothing changes" (BTC and house held where they are)
 * mode 'past' = "past growth continues" (BTC and house keep their historical rate)
 * The stablecoin positions run as pools, one per platform (see defaultPools). */
E.defaultAssumptions = function (src, state, mode) {
    const sy = E.sleeveYield(state, src.loanSim), nm = E.newMoney(src.loanSim);
    const past = mode === 'past', bg = E.btcPastGrowth(src.bootstrap);
    const pools = E.defaultPools(state, src.loanSim);
    const a = {
        mode: past ? 'past' : 'flat',
        btcGrowth: past && bg ? bg.rate : 0,
        btcShockPct: 0, btcShockMonths: 12, btcVol: E.BTC_VOL,
        sleeveYield: sy.rate,
        borrowRate: (src.aave && src.aave.borrowApr > 0) ? src.aave.borrowApr : 0.05,
        borrowRateLive: !!(src.aave && src.aave.borrowApr > 0),
        fundReturn: 0,
        houseGrowth: past ? E.HOUSE_PAST_GROWTH : 0,
        vehicleDep: E.VEHICLE_DEPRECIATION,
        newMoneyInvest: nm.invest, newMoneyLoan: nm.loan,
        freedToInvest: true, events: [], horizonMonths: 480,
    };
    // Each platform grows at its own rate (sleeveYield stays as today's average, for display).
    if (pools.length) a.pools = pools;
    return a;
};
// One yield figure for all the positions instead of a rate per platform.
E.useSingleYield = function (a, rate) { a.sleeveYield = num(rate); delete a.pools; return a; };

// FIRE plan row (fire_plan_get) -> the engine's plan object.
E.planFrom = function (firePlan) {
    const p = firePlan || {};
    const expense = num(p.desired_annual_expense), swr = num(p.safe_withdrawal_rate_pct);
    const cur = num(p.current_age), ret = num(p.retirement_age);
    return { expense, swr, fireNumber: (expense > 0 && swr > 0) ? expense / (swr / 100) : 0,
             inflation: num(p.inflation_pct) / 100, curAge: cur, retAge: ret,
             retMonth: (ret > cur) ? Math.round((ret - cur) * 12) : 0, saved: !!p.is_saved };
};

root.ZhEngine = E;
if (typeof module !== 'undefined' && module.exports) module.exports = E;
})(typeof window !== 'undefined' ? window : globalThis);
