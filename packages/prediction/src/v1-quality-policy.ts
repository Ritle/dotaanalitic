/** Preregistered engineering acceptance policy, not a claim of sufficient statistical power. */
export const V1_RELEASE_QUALITY_POLICY = {
  version: 'conditional-elo-tier1-release-v1',
  model: { initialRating: 1500, k: 32, scale: 400, sideAdvantage: false, fittedCalibrator: false,
    tuningOnTest: 'forbidden', featureProfile: 'player-mean-elo-completed-strict-v1' },
  history: { minCompletedProMapsPerPlayer: 5, playerCount: 10, minDistinctPlayers: 10,
    organizations: 'all_verified_pro', unusedFields: ['patch', 'roles', 'heroes', 'draft_order', 'first_pick', 'pubs', 'cohesion'],
    cutoff: 'completed_at_strictly_before_target_start', outcomeAvailability: 'event_time_assumed',
    identity: 'current_verified_same_numeric_account', replay: 'chronological_prequential',
    simultaneousCompletionOrder: 'completed_at_then_numeric_match_id', update: 'equal_K_delta_for_each_player_against_opposing_mean',
    historyUniverse: 'all_eligible_maps_in_frozen_inventory_since_warmupFromAt',
    coldStart: 'history_updates_allowed_but_target_prediction_unavailable' },
  selection: { unit: 'one_map', target: 'all_observed_maps_in_registered_event_windows',
    series: 'whole_known_series_no_crossing_windows_no_missing_siblings', unknownSeries: 'exclude_with_reason',
    unrelatedOverlappingSeries: 'allowed_with_strict_completed_history', overflow: 'fail_without_truncation',
    candidateLedger: 'every_discovered_id_has_a_frozen_disposition', failuresInCoverageDenominator: true,
    remoteCompleteness: 'report_unknown_unless_demonstrated', externalAccounts: 'no_nickname_merge',
    baselineAndCandidateUseIdenticalMaps: true },
  sample: { minMaps: 100, minSeries: 40, minMapCoverage: 0.8, minKnownSeriesCoverage: 0.8,
    mapCoverageDenominator: 'all_observed_target_map_ids_including_unverified_and_unknown_series',
    seriesCoverageDenominator: 'all_observed_target_known_series_including_ineligible',
    identityCoverageWithinScoredMaps: 1 },
  scoring: { orientation: 'teamA_is_lower_numeric_canonical_team_id', aggregation: 'equal_weight_per_map',
    baselineProbability: 0.5, baselineBrier: 0.25, baselineLogLoss: Math.log(2), logBase: 'natural',
    logLossClip: 1e-15, maxBrier: 0.245, maxLogLoss: 0.685,
    maxBrierDeltaUpper95: 0, maxLogLossDeltaUpper95: 0, deltaUpperComparison: 'strictly_less' },
  calibration: { bins: [0, 0.2, 0.4, 0.6, 0.8, 1], intervals: 'left_closed_right_open_last_closed',
    emptyBinRate: null, aggregation: 'sum_bin_n_over_total_times_abs_mean_probability_minus_win_rate',
    maxEce: 0.08, maxEceUpper95: 0.15, maxAbsoluteMeanProbabilityMinusWinRate: 0.05,
    reportPerBinSample: true, fitOnTest: 'forbidden' },
  uncertainty: { method: 'paired_whole_series_percentile_bootstrap', resamples: 10000, seed: 20261102,
    rng: 'mulberry32_uint32', seriesOrder: 'provider_then_numeric_series_id',
    sampleSize: 'observed_series_count_with_replacement', statistic: 'map_weighted_no_refit_or_replay',
    upperQuantile: 0.95, quantile: 'sorted_linear_interpolation_index_(n-1)*q',
    scope: 'conditional_on_observed_events_and_history_cross_series_dependence_not_removed' },
  stability: { partition: 'series_ordered_by_first_start_then_key_first_floor_half_vs_remainder',
    minMapsPerHalf: 25, minSeriesPerHalf: 10, maxBrierDeltaPerHalf: 0.02, maxLogLossDeltaPerHalf: 0.04 },
  decision: { allChecksRequired: true, insufficientSampleOrCoverage: 'insufficient_evidence',
    missingOrNonFiniteMetric: 'unavailable', metricFailure: 'failed',
    successfulEvaluation: 'eligible_for_separate_activation_review', probabilityUntilActivation: null,
    automaticActivation: false, extendWindowAfterResults: false, lowerThresholdsAfterResults: false,
    corrections: 'new_revision_keep_first_evaluation', retest: 'new_preregistered_untouched_cohort',
    executableFreeze: 'before_first_target_window_starts',
    prospectiveAccuracyClaim: false, generalization: 'pilot_scope_not_universal_tier1_accuracy' }
} as const;

function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
}
freeze(V1_RELEASE_QUALITY_POLICY);
