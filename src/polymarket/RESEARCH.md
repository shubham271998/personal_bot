# Polymarket Bot Research Summary

## What Actually Makes Money (Proven)

| Strategy | Returns | How | Our Status |
|----------|---------|-----|------------|
| Weather forecast arb | $1K→$24K | NOAA ensemble vs casual bettors | NOT IMPLEMENTED |
| News speed (Claude) | 1,322% in 48hrs | Process news faster than market | PARTIALLY (slow) |
| Crypto latency arb | $313→$438K | Sub-100ms exchange→polymarket | TOO COMPETITIVE |
| LLM ensemble | Brier 0.20 | 3+ models averaged | NOT IMPLEMENTED |
| Smart money copy | Variable | Track top 50 wallets | BASIC |

## Key Insight: Trade INEFFICIENT markets (< $100K vol, 61% accuracy)
High-volume markets ($500K+) are efficiently priced. The edge is in small, niche markets.

## Rules from History (Priority Order)

### Survival Rules (implement first)
1. Kelly sizing (half-Kelly max) — prevents ruin
2. 20% catastrophe reserve — always keep cash
3. -15% drawdown → liquidate to 50% cash, 48h cooling
4. Fee-adjusted edge check (need 7%+ after 4.5% costs)
5. Max 5% per market, max 60% same-date resolution

### Edge Generators
6. Confirmation rule — 2+ independent signals required (Livermore)
7. Mean reversion — fade >2 std dev moves without catalyst
8. Smart money tracking — follow 65%+ win rate wallets
9. Time decay — near-resolution markets have exploitable stale prices
10. Contrarian — >90% one-sided + price 75-92% = fade the crowd

### Bias Corrections
- Longshot bias: 1% displayed ≈ 0.2% real, 5% ≈ 1.5%, 10% ≈ 5%
- Overconfidence: reduce own estimates by 10-15% (Tetlock)
- Efficient market: $500K+ vol = don't trade (market is right)

## Architecture of Best Bot (dylanpersonguy)
1. Category classification (100+ regex, zero LLM cost)
2. Pre-research quality filter (blocks 90% of junk)
3. Site-restricted web search per category
4. 3-model LLM ensemble (GPT-4o 40%, Claude 35%, Gemini 25%)
5. Platt scaling calibration
6. 15+ independent risk checks
7. Fractional Kelly with 7 multipliers
8. Auto-selected execution (Simple/TWAP/Iceberg/Adaptive)

## LLM Probability Estimation
- Best single LLM: Brier 0.135-0.159
- Ensemble of 12: Brier 0.20 (matches 925 humans)
- Superforecasters: Brier 0.02 (still far ahead)
- Key: models must NOT see current market price (anchoring bias)
