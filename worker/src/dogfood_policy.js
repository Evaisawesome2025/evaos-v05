/**
 * Dogfood metering policy — copy of the box policy snapshot (2026-10-02).
 * WCincl is a conservative placeholder, not a measured founding allowance
 * and not a customer price. auto_overage stays off. payment-ready is not a field here.
 */
export const DOGFOOD_POLICY = Object.freeze({
  schema_version: 1,
  as_of_ct: "2026-10-02",
  status: "DOGFOOD_POLICY",
  notes:
    "WCincl is CONSERVATIVE PLACEHOLDER for dogfood only — NOT measured founding WCincl. Do not publish as customer allowance. Quinn illustrative ~300 @ $0.10/WC is E/A stress only.",
  workspace_id_default: "dogfood-glen",
  wc_usd_value: 0.1,
  wc_incl_per_period: 50,
  soft_warn_pct: 0.8,
  hard_stop_pct: 1,
  auto_overage: false,
  daily_max_jobs: 40,
  daily_max_cogs_usd: 5,
  reserve_floor_wc: 1,
  non_billable_classes: Object.freeze(["DEMO", "REPLAY", "SELFTEST", "SAMPLE"]),
  complexity_multipliers: Object.freeze({
    ask_reply: 1,
    objective_cycle: 2,
    audit: 1.5,
    browse: 1.5,
    orchestration: 1,
    other: 1,
  }),
  period: "calendar_month_ct",
});
